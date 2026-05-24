import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SyncManager } from '../sync';
import { GoogleDriveClient } from '../google';
import * as CryptoJS from 'crypto-js';

vi.mock('obsidian', () => {
  return {
    Notice: class {
      constructor(public message: string) {}
    },
    Plugin: class {
      manifest = { id: 'obsidian_drive_sync' };
    },
    TFile: class {},
  };
});

describe('SyncManager', () => {
  let mockApp: any;
  let mockPlugin: any;
  let mockDriveClient: any;
  let syncManager: SyncManager;
  let mockFiles: any[] = [];
  let fileContents: Record<string, string | ArrayBuffer> = {};
  let adapterFiles: Record<string, string> = {};

  beforeEach(() => {
    mockFiles = [];
    fileContents = {};
    adapterFiles = {};

    // Mock App
    mockApp = {
      vault: {
        configDir: '.obsidian',
        getFiles: () => mockFiles,
        read: async (file: any) => {
          return fileContents[file.path] as string;
        },
        readBinary: async (file: any) => {
          return fileContents[file.path] as ArrayBuffer;
        },
        adapter: {
          exists: async (path: string) => {
            return path in adapterFiles;
          },
          read: async (path: string) => {
            return adapterFiles[path];
          },
          write: async (path: string, content: string) => {
            adapterFiles[path] = content;
          },
        },
      },
    };

    // Mock Plugin
    mockPlugin = {
      manifest: {
        id: 'obsidian_drive_sync',
      },
    };

    // Mock GoogleDriveClient
    mockDriveClient = {
      folderExists: vi.fn().mockResolvedValue(true),
      findItem: vi.fn(),
      createFolder: vi.fn(),
      resolveFolderHierarchy: vi.fn(),
      createFile: vi.fn(),
      updateFileContent: vi.fn(),
    } as unknown as GoogleDriveClient;

    syncManager = new SyncManager(mockApp, mockPlugin, mockDriveClient);
  });

  it('should load empty state if sync_state.json does not exist', async () => {
    await syncManager.loadState();
    expect(syncManager['state']).toEqual({ files: {} });
  });

  it('should load existing state from sync_state.json', async () => {
    const existingState = {
      files: {
        'test.md': {
          hash: 'abc',
          driveFileId: 'id123',
          lastSyncTime: 12345,
          deleted: false,
        },
      },
    };
    adapterFiles['.obsidian/plugins/obsidian_drive_sync/sync_state.json'] = JSON.stringify(existingState);

    await syncManager.loadState();
    expect(syncManager['state']).toEqual(existingState);
  });

  it('should sync unseen files (create on Google Drive)', async () => {
    // 1. Setup local file
    const content = 'Hello world';
    const expectedHash = CryptoJS.MD5(content).toString();
    mockFiles.push({
      path: 'test.md',
      name: 'test.md',
      extension: 'md',
    });
    fileContents['test.md'] = content;

    // 2. Setup Google Drive Client Mocks
    mockDriveClient.resolveFolderHierarchy.mockResolvedValue('driveFolderId');
    mockDriveClient.findItem.mockResolvedValue(null); // File doesn't exist on Drive
    mockDriveClient.createFile.mockResolvedValue('newDriveFileId');

    // 3. Run sync
    await syncManager.runSync('destinationFolderId');

    // 4. Assertions
    expect(mockDriveClient.resolveFolderHierarchy).toHaveBeenCalledWith([], 'destinationFolderId');
    expect(mockDriveClient.createFile).toHaveBeenCalledWith('test.md', 'driveFolderId', content);
    
    // State is updated and written to disk
    const savedState = JSON.parse(adapterFiles['.obsidian/plugins/obsidian_drive_sync/sync_state.json'] || '{}');
    expect(savedState.files['test.md']).toBeDefined();
    expect(savedState.files['test.md'].hash).toBe(expectedHash);
    expect(savedState.files['test.md'].driveFileId).toBe('newDriveFileId');
    expect(savedState.files['test.md'].deleted).toBe(false);
  });

  it('should skip already synced and unchanged files', async () => {
    // 1. Setup local file and existing state
    const content = 'Unchanged content';
    const hash = CryptoJS.MD5(content).toString();
    mockFiles.push({
      path: 'test.md',
      name: 'test.md',
      extension: 'md',
    });
    fileContents['test.md'] = content;

    const existingState = {
      files: {
        'test.md': {
          hash: hash,
          driveFileId: 'id123',
          lastSyncTime: Date.now(),
          deleted: false,
        },
      },
    };
    adapterFiles['.obsidian/plugins/obsidian_drive_sync/sync_state.json'] = JSON.stringify(existingState);

    // 2. Run sync
    await syncManager.runSync('destinationFolderId');

    // 3. Assertions: client methods should NOT be called
    expect(mockDriveClient.createFile).not.toHaveBeenCalled();
    expect(mockDriveClient.updateFileContent).not.toHaveBeenCalled();
  });

  it('should update modified files on Google Drive', async () => {
    // 1. Setup local file with updated content and existing state with old hash
    const oldHash = CryptoJS.MD5('Old Content').toString();
    const newContent = 'Updated Content';
    const newHash = CryptoJS.MD5(newContent).toString();
    mockFiles.push({
      path: 'test.md',
      name: 'test.md',
      extension: 'md',
    });
    fileContents['test.md'] = newContent;

    const existingState = {
      files: {
        'test.md': {
          hash: oldHash,
          driveFileId: 'id123',
          lastSyncTime: Date.now(),
          deleted: false,
        },
      },
    };
    adapterFiles['.obsidian/plugins/obsidian_drive_sync/sync_state.json'] = JSON.stringify(existingState);

    // 2. Google Drive mocks
    mockDriveClient.resolveFolderHierarchy.mockResolvedValue('driveFolderId');
    mockDriveClient.findItem.mockResolvedValue({ id: 'id123' }); // File exists on Drive

    // 3. Run sync
    await syncManager.runSync('destinationFolderId');

    // 4. Assertions
    expect(mockDriveClient.updateFileContent).toHaveBeenCalledWith('id123', newContent);
    
    const savedState = JSON.parse(adapterFiles['.obsidian/plugins/obsidian_drive_sync/sync_state.json'] || '{}');
    expect(savedState.files['test.md'].hash).toBe(newHash);
  });

  it('should mark locally deleted files as deleted in the state', async () => {
    // 1. Setup empty vault but existing file in state
    const existingState = {
      files: {
        'deleted_file.md': {
          hash: 'oldhash',
          driveFileId: 'id123',
          lastSyncTime: Date.now(),
          deleted: false,
        },
      },
    };
    adapterFiles['.obsidian/plugins/obsidian_drive_sync/sync_state.json'] = JSON.stringify(existingState);

    // 2. Run sync
    await syncManager.runSync('destinationFolderId');

    // 3. Assertions
    const savedState = JSON.parse(adapterFiles['.obsidian/plugins/obsidian_drive_sync/sync_state.json'] || '{}');
    expect(savedState.files['deleted_file.md'].deleted).toBe(true);
    expect(mockDriveClient.createFile).not.toHaveBeenCalled();
    expect(mockDriveClient.updateFileContent).not.toHaveBeenCalled();
  });

  it('should ignore files with hidden folders or files starting with a dot anywhere in the path', async () => {
    // 1. Setup local files: normal, root hidden, nested hidden
    mockFiles.push({
      path: 'normal.md',
      name: 'normal.md',
      extension: 'md',
    });
    mockFiles.push({
      path: '.hidden_at_root.md',
      name: '.hidden_at_root.md',
      extension: 'md',
    });
    mockFiles.push({
      path: 'folder/.hidden_subfolder/test.md',
      name: 'test.md',
      extension: 'md',
    });
    mockFiles.push({
      path: '.obsidian/plugins/test/main.js',
      name: 'main.js',
      extension: 'js',
    });

    fileContents['normal.md'] = 'normal';
    fileContents['.hidden_at_root.md'] = 'hidden';
    fileContents['folder/.hidden_subfolder/test.md'] = 'hidden';
    fileContents['.obsidian/plugins/test/main.js'] = 'js';

    // 2. Drive mocks
    mockDriveClient.resolveFolderHierarchy.mockResolvedValue('driveFolderId');
    mockDriveClient.findItem.mockResolvedValue(null);
    mockDriveClient.createFile.mockResolvedValue('newFileId');

    // 3. Run sync
    await syncManager.runSync('destinationFolderId');

    // 4. Assertions: only normal.md is synced
    expect(mockDriveClient.createFile).toHaveBeenCalledTimes(1);
    expect(mockDriveClient.createFile).toHaveBeenCalledWith('normal.md', 'driveFolderId', 'normal');
  });

  it('should resolve nested folder hierarchies on Google Drive', async () => {
    // 1. Setup local nested file
    mockFiles.push({
      path: 'FolderA/FolderB/nested.md',
      name: 'nested.md',
      extension: 'md',
    });
    fileContents['FolderA/FolderB/nested.md'] = 'nested content';

    // 2. Drive mocks
    mockDriveClient.resolveFolderHierarchy.mockResolvedValue('leafFolderId');
    mockDriveClient.findItem.mockResolvedValue(null);
    mockDriveClient.createFile.mockResolvedValue('nestedFileId');

    // 3. Run sync
    await syncManager.runSync('destinationFolderId');

    // 4. Assertions: hierarchy was resolved with path parts ['FolderA', 'FolderB']
    expect(mockDriveClient.resolveFolderHierarchy).toHaveBeenCalledWith(['FolderA', 'FolderB'], 'destinationFolderId');
    expect(mockDriveClient.createFile).toHaveBeenCalledWith('nested.md', 'leafFolderId', 'nested content');
  });

  it('should handle files at the vault root level', async () => {
    // 1. Setup root file
    mockFiles.push({
      path: 'rootfile.md',
      name: 'rootfile.md',
      extension: 'md',
    });
    fileContents['rootfile.md'] = 'root content';

    // 2. Drive mocks
    mockDriveClient.resolveFolderHierarchy.mockResolvedValue('destinationFolderId');
    mockDriveClient.findItem.mockResolvedValue(null);
    mockDriveClient.createFile.mockResolvedValue('rootFileId');

    // 3. Run sync
    await syncManager.runSync('destinationFolderId');

    // 4. Assertions: hierarchy resolves with empty parts array []
    expect(mockDriveClient.resolveFolderHierarchy).toHaveBeenCalledWith([], 'destinationFolderId');
    expect(mockDriveClient.createFile).toHaveBeenCalledWith('rootfile.md', 'destinationFolderId', 'root content');
  });

  it('should skip sync if destinationFolderId is invalid or dot "."', async () => {
    mockFiles.push({
      path: 'rootfile.md',
      name: 'rootfile.md',
      extension: 'md',
    });
    fileContents['rootfile.md'] = 'root content';

    await syncManager.runSync('.');

    expect(mockDriveClient.resolveFolderHierarchy).not.toHaveBeenCalled();
    expect(mockDriveClient.createFile).not.toHaveBeenCalled();
  });

  it('should resolve existing folder by name if destinationFolderId does not exist by ID', async () => {
    mockFiles.push({
      path: 'rootfile.md',
      name: 'rootfile.md',
      extension: 'md',
    });
    fileContents['rootfile.md'] = 'root content';

    mockDriveClient.folderExists.mockResolvedValueOnce(false);
    mockDriveClient.findItem.mockResolvedValueOnce({ id: 'resolvedRealFolderId' });
    mockDriveClient.resolveFolderHierarchy.mockResolvedValue('resolvedRealFolderId');

    mockPlugin.settings = { destinationFolderId: 'MyFolder' };
    mockPlugin.saveSettings = vi.fn().mockResolvedValue(undefined);

    await syncManager.runSync('MyFolder');

    expect(mockPlugin.settings.destinationFolderId).toBe('resolvedRealFolderId');
    expect(mockPlugin.saveSettings).toHaveBeenCalled();
    expect(mockDriveClient.resolveFolderHierarchy).toHaveBeenCalledWith([], 'resolvedRealFolderId');
  });

  it('should create new folder if destinationFolderId does not exist by ID or name', async () => {
    mockFiles.push({
      path: 'rootfile.md',
      name: 'rootfile.md',
      extension: 'md',
    });
    fileContents['rootfile.md'] = 'root content';

    mockDriveClient.folderExists.mockResolvedValueOnce(false);
    mockDriveClient.findItem.mockResolvedValueOnce(null);
    mockDriveClient.createFolder.mockResolvedValueOnce('newCreatedFolderId');
    mockDriveClient.resolveFolderHierarchy.mockResolvedValue('newCreatedFolderId');

    mockPlugin.settings = { destinationFolderId: 'NewFolder' };
    mockPlugin.saveSettings = vi.fn().mockResolvedValue(undefined);

    await syncManager.runSync('NewFolder');

    expect(mockPlugin.settings.destinationFolderId).toBe('newCreatedFolderId');
    expect(mockPlugin.saveSettings).toHaveBeenCalled();
    expect(mockDriveClient.resolveFolderHierarchy).toHaveBeenCalledWith([], 'newCreatedFolderId');
  });

  it('should debounce single file sync modification', async () => {
    vi.useFakeTimers();

    const file = {
      path: 'debian.md',
      name: 'debian.md',
      extension: 'md',
    };
    mockFiles.push(file);
    fileContents['debian.md'] = 'debian content';

    mockDriveClient.resolveFolderHierarchy.mockResolvedValue('destId');
    mockDriveClient.findItem.mockResolvedValue(null);
    mockDriveClient.createFile.mockResolvedValue('newFileId');

    syncManager.debounceSyncFile(file as any, 'destId');

    // Should not have resolved hierarchy yet (debounced)
    expect(mockDriveClient.resolveFolderHierarchy).not.toHaveBeenCalled();

    // Fast-forward time
    await vi.advanceTimersByTimeAsync(5000);

    // Now it should have been synced
    expect(mockDriveClient.resolveFolderHierarchy).toHaveBeenCalledWith([], 'destId');
    expect(mockDriveClient.createFile).toHaveBeenCalledWith('debian.md', 'destId', 'debian content');

    vi.useRealTimers();
  });

  it('should cancel timer and mark as deleted on handleLocalDeletion', async () => {
    vi.useFakeTimers();

    const file = {
      path: 'del.md',
      name: 'del.md',
      extension: 'md',
    };
    
    // Add to state first
    const existingState = {
      files: {
        'del.md': {
          hash: 'hash123',
          driveFileId: 'driveId123',
          lastSyncTime: Date.now(),
          deleted: false,
        },
      },
    };
    adapterFiles['.obsidian/plugins/obsidian_drive_sync/sync_state.json'] = JSON.stringify(existingState);

    // Trigger a debounced sync, then immediately delete
    syncManager.debounceSyncFile(file as any, 'destId');
    await syncManager.handleLocalDeletion('del.md');

    // Fast-forward time
    await vi.advanceTimersByTimeAsync(5000);

    // It should NOT run sync (since timer was cancelled)
    expect(mockDriveClient.resolveFolderHierarchy).not.toHaveBeenCalled();

    // Check state has been marked deleted
    const savedState = JSON.parse(adapterFiles['.obsidian/plugins/obsidian_drive_sync/sync_state.json'] || '{}');
    expect(savedState.files['del.md'].deleted).toBe(true);

    vi.useRealTimers();
  });

  it('should handle local rename by deleting old path and syncing new path', async () => {
    const file = {
      path: 'new.md',
      name: 'new.md',
      extension: 'md',
    };
    mockFiles.push(file);
    fileContents['new.md'] = 'new content';

    // Add old file to state
    const existingState = {
      files: {
        'old.md': {
          hash: 'hash123',
          driveFileId: 'driveId123',
          lastSyncTime: Date.now(),
          deleted: false,
        },
      },
    };
    adapterFiles['.obsidian/plugins/obsidian_drive_sync/sync_state.json'] = JSON.stringify(existingState);

    mockDriveClient.resolveFolderHierarchy.mockResolvedValue('destId');
    mockDriveClient.findItem.mockResolvedValue(null);
    mockDriveClient.createFile.mockResolvedValue('newFileId');

    await syncManager.handleLocalRename('old.md', file as any, 'destId');

    // Check old file state is deleted
    const savedState = JSON.parse(adapterFiles['.obsidian/plugins/obsidian_drive_sync/sync_state.json'] || '{}');
    expect(savedState.files['old.md'].deleted).toBe(true);

    // Check new file was immediately synced
    expect(mockDriveClient.createFile).toHaveBeenCalledWith('new.md', 'destId', 'new content');
    // Verify new file exists in state with correct fields
    const savedStatePost = JSON.parse(adapterFiles['.obsidian/plugins/obsidian_drive_sync/sync_state.json'] || '{}');
    expect(savedStatePost.files['new.md']).toBeDefined();
    expect(savedStatePost.files['new.md'].driveFileId).toBe('newFileId');
  });
});
