import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TFile, TFolder } from 'obsidian';
import { SyncManager } from '../sync';
import { GoogleDriveClient } from '../google';
import * as CryptoJS from 'crypto-js';

// Define the global compile-time constant for the test runner environment
(globalThis as any).DEBUG_LOGGING = true;

vi.mock('obsidian', () => {
  return {
    Notice: class {
      constructor(public message: string) {}
    },
    Plugin: class {
      manifest = { id: 'obsidian_drive_sync' };
    },
    TFile: class {},
    TFolder: class {
      children: any[] = [];
      path = '';
      isRoot() {
        return this.path === '/' || this.path === '';
      }
    },
    Modal: class {
      constructor(public app: any) {}
      open() {}
      close() {}
    },
  };
});

describe('SyncManager', () => {
  let mockApp: any;
  let mockPlugin: any;
  let mockDriveClient: any;
  let syncManager: SyncManager;
  let mockFiles: any[] = [];
  let mockFolders: any[] = [];
  let fileContents: Record<string, string | ArrayBuffer> = {};
  let adapterFiles: Record<string, string> = {};

  beforeEach(() => {
    mockFiles = [];
    mockFolders = [];
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
        getAllLoadedFiles: vi.fn().mockImplementation(() => {
          const fileInstances = mockFiles.map(f => {
            const fileInstance = new TFile();
            Object.assign(fileInstance, f);
            return fileInstance;
          });
          const folderInstances = mockFolders.map(d => {
            const folderInstance = new TFolder();
            Object.assign(folderInstance, d);
            return folderInstance;
          });
          for (const folder of folderInstances) {
            folder.children = [
              ...fileInstances.filter(f => {
                const parts = f.path.split('/');
                parts.pop();
                return parts.join('/') === folder.path;
              }),
              ...folderInstances.filter(f => {
                const parts = f.path.split('/');
                parts.pop();
                return parts.join('/') === folder.path && f.path !== folder.path;
              })
            ];
          }
          return [...fileInstances, ...folderInstances];
        }),
        getAbstractFileByPath: vi.fn().mockImplementation((path) => {
          const f = mockFiles.find(file => file.path === path);
          if (f) {
            const fileInstance = new TFile();
            Object.assign(fileInstance, f);
            return fileInstance;
          }
          const folderDef = mockFolders.find(fold => fold.path === path);
          if (folderDef) {
            const folderInstance = new TFolder();
            Object.assign(folderInstance, folderDef);
            const fileInstances = mockFiles.map(mf => {
              const fileInstance = new TFile();
              Object.assign(fileInstance, mf);
              return fileInstance;
            });
            const folderInstances = mockFolders.map(md => {
              const folderInstance = new TFolder();
              Object.assign(folderInstance, md);
              return folderInstance;
            });
            folderInstance.children = [
              ...fileInstances.filter(fi => {
                const parts = fi.path.split('/');
                parts.pop();
                return parts.join('/') === folderInstance.path;
              }),
              ...folderInstances.filter(fo => {
                const parts = fo.path.split('/');
                parts.pop();
                return parts.join('/') === folderInstance.path && fo.path !== folderInstance.path;
              })
            ];
            return folderInstance;
          }
          return null;
        }),
        delete: vi.fn().mockImplementation(async (item) => {
          const idx = mockFiles.findIndex(f => f.path === item.path);
          if (idx !== -1) {
            mockFiles.splice(idx, 1);
          }
          const folderIdx = mockFolders.findIndex(f => f.path === item.path);
          if (folderIdx !== -1) {
            mockFolders.splice(folderIdx, 1);
          }
          delete fileContents[item.path];
          delete adapterFiles[item.path];
        }),
        createFolder: vi.fn().mockResolvedValue(undefined),
        create: vi.fn().mockImplementation(async (path, content) => {
          adapterFiles[path] = content;
          fileContents[path] = content;
          mockFiles.push({ path, name: path.split('/').pop(), extension: path.split('.').pop() });
        }),
        createBinary: vi.fn().mockImplementation(async (path, content) => {
          fileContents[path] = content;
          mockFiles.push({ path, name: path.split('/').pop(), extension: path.split('.').pop() });
        }),
        modify: vi.fn().mockImplementation(async (file, content) => {
          adapterFiles[file.path] = content;
          fileContents[file.path] = content;
        }),
        modifyBinary: vi.fn().mockImplementation(async (file, content) => {
          fileContents[file.path] = content;
        }),
        rename: vi.fn().mockImplementation(async (file, newPath) => {
          const oldPath = file.path;
          file.path = newPath;
          if (oldPath in adapterFiles) {
            const content = adapterFiles[oldPath];
            if (content !== undefined) {
              adapterFiles[newPath] = content;
            }
            delete adapterFiles[oldPath];
          }
          if (oldPath in fileContents) {
            const content = fileContents[oldPath];
            if (content !== undefined) {
              fileContents[newPath] = content;
            }
            delete fileContents[oldPath];
          }
          const fIndex = mockFiles.findIndex(f => f.path === oldPath);
          if (fIndex !== -1) {
            const mockFile = mockFiles[fIndex];
            if (mockFile) {
              mockFile.path = newPath;
            }
          }
        }),
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
      settings: {
        destinationFolderId: 'destId',
        destinationFolderName: 'MyFolder',
      },
      saveSettings: vi.fn().mockResolvedValue(undefined),
    };

    // Mock GoogleDriveClient
    mockDriveClient = {
      folderExists: vi.fn().mockResolvedValue(true),
      getFolderMetadata: vi.fn().mockImplementation(async (id) => {
        if (id === 'root') {
          return { id: 'root', name: 'root', mimeType: 'application/vnd.google-apps.folder', trashed: false };
        }
        if (id === 'invalidId' || id === 'nonexistentId') {
          return null;
        }
        return { id: id, name: 'MyFolder', mimeType: 'application/vnd.google-apps.folder', trashed: false };
      }),
      getFileMetadata: vi.fn().mockImplementation(async (id) => {
        if (id === 'invalidId' || id === 'nonexistentId') {
          return null;
        }
        return { id: id, name: 'test.md', mimeType: 'text/markdown', parents: ['destId'], trashed: false };
      }),
      deleteItem: vi.fn().mockResolvedValue(undefined),
      listFilesInFolder: vi.fn().mockResolvedValue([]),
      renameItem: vi.fn().mockResolvedValue(undefined),
      getFileParents: vi.fn().mockResolvedValue([]),
      moveFile: vi.fn().mockResolvedValue(undefined),
      findItem: vi.fn(),
      createFolder: vi.fn(),
      resolveFolderHierarchy: vi.fn(),
      createFile: vi.fn(),
      updateFileContent: vi.fn(),
      downloadFile: vi.fn().mockImplementation(async (id) => {
        return new TextEncoder().encode('remote content').buffer;
      }),
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

    mockDriveClient.getFolderMetadata.mockResolvedValueOnce(null);
    mockDriveClient.getFolderMetadata.mockResolvedValueOnce(null);
    mockDriveClient.findItem.mockResolvedValueOnce({ id: 'resolvedRealFolderId' });
    mockDriveClient.resolveFolderHierarchy.mockResolvedValue('resolvedRealFolderId');

    mockPlugin.settings = { destinationFolderId: 'MyFolder', destinationFolderName: 'MyFolder' };
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

    mockDriveClient.getFolderMetadata.mockResolvedValueOnce(null);
    mockDriveClient.getFolderMetadata.mockResolvedValueOnce(null);
    mockDriveClient.findItem.mockResolvedValueOnce(null);
    mockDriveClient.createFolder.mockResolvedValueOnce('newCreatedFolderId');
    mockDriveClient.resolveFolderHierarchy.mockResolvedValue('newCreatedFolderId');

    mockPlugin.settings = { destinationFolderId: 'NewFolder', destinationFolderName: 'NewFolder' };
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

    // Mock askDeleteChoice to resolve immediately so it doesn't hang
    const askDeleteSpy = vi.spyOn(syncManager as any, 'askDeleteChoice')
      .mockResolvedValue({ choice: 'skip', applyToAll: false });

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

  it('should fallback to clean upload on rename if old file has no cached driveFileId', async () => {
    const file = {
      path: 'new.md',
      name: 'new.md',
      extension: 'md',
    };
    mockFiles.push(file);
    fileContents['new.md'] = 'new content';

    // Empty state (no old.md)
    const existingState = { files: {} };
    adapterFiles['.obsidian/plugins/obsidian_drive_sync/sync_state.json'] = JSON.stringify(existingState);

    mockDriveClient.resolveFolderHierarchy.mockResolvedValue('destId');
    mockDriveClient.findItem.mockResolvedValue(null);
    mockDriveClient.createFile.mockResolvedValue('newFileId');

    await syncManager.handleLocalRename('old.md', file as any, 'destId');

    // Check new file was immediately synced
    expect(mockDriveClient.createFile).toHaveBeenCalledWith('new.md', 'destId', 'new content');
    const savedStatePost = JSON.parse(adapterFiles['.obsidian/plugins/obsidian_drive_sync/sync_state.json'] || '{}');
    expect(savedStatePost.files['new.md']).toBeDefined();
    expect(savedStatePost.files['new.md'].driveFileId).toBe('newFileId');
  });

  it('should reparent and update file on rename if old file exists in state', async () => {
    const file = {
      path: 'FolderB/test.md',
      name: 'test.md',
      extension: 'md',
    };
    mockFiles.push(file);
    fileContents['FolderB/test.md'] = 'new content';

    // Add old file to state
    const existingState = {
      files: {
        'FolderA/test.md': {
          hash: 'oldHash',
          driveFileId: 'driveId123',
          lastSyncTime: Date.now(),
          deleted: false,
        },
      },
    };
    adapterFiles['.obsidian/plugins/obsidian_drive_sync/sync_state.json'] = JSON.stringify(existingState);

    // Mock parent folder resolution
    mockDriveClient.resolveFolderHierarchy.mockResolvedValue('FolderB_Id');
    
    // Mock getFileParents to return the old parent folder ID
    mockDriveClient.getFileParents = vi.fn().mockResolvedValue(['FolderA_Id']);
    
    // Mock moveFile and updateFileContent
    mockDriveClient.moveFile = vi.fn().mockResolvedValue(undefined);
    mockDriveClient.updateFileContent = vi.fn().mockResolvedValue(undefined);

    await syncManager.handleLocalRename('FolderA/test.md', file as any, 'destId');

    // 1. Verify file was moved/reparented
    expect(mockDriveClient.moveFile).toHaveBeenCalledWith('driveId123', 'FolderA_Id', 'FolderB_Id', 'test.md');

    // 2. Verify file content was updated (since content changed from 'oldHash' to 'new content')
    expect(mockDriveClient.updateFileContent).toHaveBeenCalledWith('driveId123', 'new content');

    // 3. Verify state was updated (old path removed, new path added)
    const savedState = JSON.parse(adapterFiles['.obsidian/plugins/obsidian_drive_sync/sync_state.json'] || '{}');
    expect(savedState.files['FolderA/test.md']).toBeUndefined();
    expect(savedState.files['FolderB/test.md']).toBeDefined();
    expect(savedState.files['FolderB/test.md'].driveFileId).toBe('driveId123');
  });

  it('should heuristically pair and reparent renamed files offline during runSync', async () => {
    const file = {
      path: 'FolderB/note.md',
      name: 'note.md',
      extension: 'md',
    };
    mockFiles.push(file);
    fileContents['FolderB/note.md'] = 'updated content';

    // Add old file to state
    const existingState = {
      files: {
        'FolderA/note.md': {
          hash: 'oldHash',
          driveFileId: 'driveIdNote',
          lastSyncTime: Date.now(),
          deleted: false,
        },
      },
    };
    adapterFiles['.obsidian/plugins/obsidian_drive_sync/sync_state.json'] = JSON.stringify(existingState);

    // Mock parent folder resolution and metadata checks
    mockDriveClient.resolveFolderHierarchy.mockResolvedValue('FolderB_Id');
    mockDriveClient.getFolderMetadata.mockResolvedValue({
      id: 'destId',
      name: 'MyFolder',
      mimeType: 'application/vnd.google-apps.folder',
      trashed: false
    });
    mockDriveClient.getFileParents = vi.fn().mockResolvedValue(['FolderA_Id']);
    mockDriveClient.moveFile = vi.fn().mockResolvedValue(undefined);
    mockDriveClient.updateFileContent = vi.fn().mockResolvedValue(undefined);

    await syncManager.runSync('destId');

    // 1. Verify file was moved/reparented on Drive using its cached ID
    expect(mockDriveClient.moveFile).toHaveBeenCalledWith('driveIdNote', 'FolderA_Id', 'FolderB_Id', 'note.md');

    // 2. Verify file content was updated on Drive
    expect(mockDriveClient.updateFileContent).toHaveBeenCalledWith('driveIdNote', 'updated content');

    // 3. Verify state cache removes old path and adds new path
    const savedState = JSON.parse(adapterFiles['.obsidian/plugins/obsidian_drive_sync/sync_state.json'] || '{}');
    expect(savedState.files['FolderA/note.md']).toBeUndefined();
    expect(savedState.files['FolderB/note.md']).toBeDefined();
    expect(savedState.files['FolderB/note.md'].driveFileId).toBe('driveIdNote');
  });

  it('should delete local file on remote deletion if file no longer exists on Google Drive', async () => {
    // 1. Setup local file and sync state
    const file = {
      path: 'remote-deleted.md',
      name: 'remote-deleted.md',
      extension: 'md',
    };
    mockFiles.push(file);
    const content = 'content';
    fileContents['remote-deleted.md'] = content;
    const hash = CryptoJS.MD5(content).toString();

    const existingState = {
      files: {
        'remote-deleted.md': {
          hash: hash,
          driveFileId: 'driveId123',
          lastSyncTime: Date.now(),
          deleted: false,
        },
      },
    };
    adapterFiles['.obsidian/plugins/obsidian_drive_sync/sync_state.json'] = JSON.stringify(existingState);

    // Mock getFileMetadata to return null (meaning file was deleted on Drive)
    mockDriveClient.getFileMetadata.mockResolvedValueOnce(null);

    // Mock vault functions
    const localFileInstance = new TFile();
    (localFileInstance as any).path = 'remote-deleted.md';
    (localFileInstance as any).extension = 'md';
    mockApp.vault.getAbstractFileByPath = vi.fn().mockReturnValue(localFileInstance);
    mockApp.vault.delete = vi.fn().mockResolvedValue(undefined);

    // 2. Run sync
    await syncManager.runSync('destId');

    // 3. Assertions
    expect(mockApp.vault.delete).toHaveBeenCalledWith(localFileInstance);
    const savedState = JSON.parse(adapterFiles['.obsidian/plugins/obsidian_drive_sync/sync_state.json'] || '{}');
    expect(savedState.files['remote-deleted.md'].deleted).toBe(true);
  });

  it('should prompt user on local deletion and clear driveFileId if skipped', async () => {
    // 1. Setup sync state with a file that exists on Drive but is missing locally
    const existingState = {
      files: {
        'local-skipped-deleted.md': {
          hash: 'someHash',
          driveFileId: 'driveId123',
          lastSyncTime: Date.now(),
          deleted: false,
        },
      },
    };
    adapterFiles['.obsidian/plugins/obsidian_drive_sync/sync_state.json'] = JSON.stringify(existingState);

    // Mock listFilesInFolder to return the file on Drive
    mockDriveClient.listFilesInFolder.mockResolvedValueOnce([
      { id: 'driveId123', name: 'local-skipped-deleted.md', mimeType: 'text/markdown', md5Checksum: 'someHash' }
    ]);

    // Spy on askDeleteChoice and mock it to return 'skip'
    const askDeleteSpy = vi.spyOn(syncManager as any, 'askDeleteChoice')
      .mockResolvedValue({ choice: 'skip', applyToAll: false });

    // 2. Run sync
    await syncManager.runSync('destId');

    // 3. Assertions
    expect(askDeleteSpy).toHaveBeenCalledWith('local-skipped-deleted.md');
    expect(mockDriveClient.deleteItem).not.toHaveBeenCalled();

    const savedState = JSON.parse(adapterFiles['.obsidian/plugins/obsidian_drive_sync/sync_state.json'] || '{}');
    expect(savedState.files['local-skipped-deleted.md'].deleted).toBe(true);
    expect(savedState.files['local-skipped-deleted.md'].driveFileId).toBe('');
  });

  it('should prompt user on local deletion and delete from Drive if confirmed', async () => {
    // 1. Setup sync state with a file that exists on Drive but is missing locally
    const existingState = {
      files: {
        'local-confirmed-deleted.md': {
          hash: 'someHash',
          driveFileId: 'driveId456',
          lastSyncTime: Date.now(),
          deleted: false,
        },
      },
    };
    adapterFiles['.obsidian/plugins/obsidian_drive_sync/sync_state.json'] = JSON.stringify(existingState);

    // Mock listFilesInFolder to return the file on Drive
    mockDriveClient.listFilesInFolder.mockResolvedValueOnce([
      { id: 'driveId456', name: 'local-confirmed-deleted.md', mimeType: 'text/markdown', md5Checksum: 'someHash' }
    ]);

    // Spy on askDeleteChoice and mock it to return 'delete'
    const askDeleteSpy = vi.spyOn(syncManager as any, 'askDeleteChoice')
      .mockResolvedValue({ choice: 'delete', applyToAll: false });

    // 2. Run sync
    await syncManager.runSync('destId');

    // 3. Assertions
    expect(askDeleteSpy).toHaveBeenCalledWith('local-confirmed-deleted.md');
    expect(mockDriveClient.deleteItem).toHaveBeenCalledWith('driveId456');

    const savedState = JSON.parse(adapterFiles['.obsidian/plugins/obsidian_drive_sync/sync_state.json'] || '{}');
    expect(savedState.files['local-confirmed-deleted.md'].deleted).toBe(true);
  });

  it('should apply the same choice to subsequent deletions when applyToAll is true', async () => {
    // 1. Setup sync state with two files that exist on Drive but are missing locally
    const existingState = {
      files: {
        'file1.md': {
          hash: 'someHash',
          driveFileId: 'driveId1',
          lastSyncTime: Date.now(),
          deleted: false,
        },
        'file2.md': {
          hash: 'someHash',
          driveFileId: 'driveId2',
          lastSyncTime: Date.now(),
          deleted: false,
        },
      },
    };
    adapterFiles['.obsidian/plugins/obsidian_drive_sync/sync_state.json'] = JSON.stringify(existingState);

    // Mock listFilesInFolder to return both files on Drive
    mockDriveClient.listFilesInFolder.mockResolvedValueOnce([
      { id: 'driveId1', name: 'file1.md', mimeType: 'text/markdown', md5Checksum: 'someHash' },
      { id: 'driveId2', name: 'file2.md', mimeType: 'text/markdown', md5Checksum: 'someHash' }
    ]);

    // Spy on askDeleteChoice and mock it to return 'delete' with applyToAll: true
    const askDeleteSpy = vi.spyOn(syncManager as any, 'askDeleteChoice')
      .mockResolvedValueOnce({ choice: 'delete', applyToAll: true });

    // 2. Run sync
    await syncManager.runSync('destId');

    // 3. Assertions
    // askDeleteChoice should only be called once (for the first file encountered)
    expect(askDeleteSpy).toHaveBeenCalledTimes(1);
    
    // Both items should be deleted from Drive
    expect(mockDriveClient.deleteItem).toHaveBeenCalledWith('driveId1');
    expect(mockDriveClient.deleteItem).toHaveBeenCalledWith('driveId2');

    const savedState = JSON.parse(adapterFiles['.obsidian/plugins/obsidian_drive_sync/sync_state.json'] || '{}');
    expect(savedState.files['file1.md'].deleted).toBe(true);
    expect(savedState.files['file2.md'].deleted).toBe(true);
  });

  it('should propagate deletion to Drive in real-time on handleLocalDeletion if confirmed', async () => {
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

    const askDeleteSpy = vi.spyOn(syncManager as any, 'askDeleteChoice')
      .mockResolvedValue({ choice: 'delete', applyToAll: false });

    await syncManager.handleLocalDeletion('del.md');

    expect(askDeleteSpy).toHaveBeenCalledWith('del.md');
    expect(mockDriveClient.deleteItem).toHaveBeenCalledWith('driveId123');

    const savedState = JSON.parse(adapterFiles['.obsidian/plugins/obsidian_drive_sync/sync_state.json'] || '{}');
    expect(savedState.files['del.md'].deleted).toBe(true);
  });

  it('should skip deletion and clear driveFileId in real-time on handleLocalDeletion if skipped', async () => {
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

    const askDeleteSpy = vi.spyOn(syncManager as any, 'askDeleteChoice')
      .mockResolvedValue({ choice: 'skip', applyToAll: false });

    await syncManager.handleLocalDeletion('del.md');

    expect(askDeleteSpy).toHaveBeenCalledWith('del.md');
    expect(mockDriveClient.deleteItem).not.toHaveBeenCalled();

    const savedState = JSON.parse(adapterFiles['.obsidian/plugins/obsidian_drive_sync/sync_state.json'] || '{}');
    expect(savedState.files['del.md'].deleted).toBe(true);
    expect(savedState.files['del.md'].driveFileId).toBe('');
  });

  it('should download new remote file and create local folder recursively', async () => {
    // 1. Setup listFilesInFolder to return a subfolder first, then a file inside it
    mockDriveClient.listFilesInFolder = vi.fn()
      .mockImplementation(async (folderId) => {
        if (folderId === 'destId') {
          return [
            { id: 'folderId1', name: 'FolderA', mimeType: 'application/vnd.google-apps.folder' }
          ];
        }
        if (folderId === 'folderId1') {
          return [
            { id: 'driveFileId1', name: 'note.md', mimeType: 'text/markdown', md5Checksum: CryptoJS.MD5('remote content').toString() }
          ];
        }
        return [];
      });

    mockDriveClient.downloadFile = vi.fn().mockImplementation(async (fileId) => {
      if (fileId === 'driveFileId1') {
        return new TextEncoder().encode('remote content').buffer;
      }
      throw new Error('Unexpected download');
    });

    // 2. Run sync
    await syncManager.runSync('destId');

    // 3. Assertions
    expect(mockApp.vault.createFolder).toHaveBeenCalledWith('FolderA');
    expect(fileContents['FolderA/note.md']).toBe('remote content');

    const savedState = JSON.parse(adapterFiles['.obsidian/plugins/obsidian_drive_sync/sync_state.json'] || '{}');
    expect(savedState.files['FolderA/note.md']).toBeDefined();
    expect(savedState.files['FolderA/note.md'].driveFileId).toBe('driveFileId1');
    expect(savedState.files['FolderA/note.md'].hash).toBe(CryptoJS.MD5('remote content').toString());
  });

  it('should download modified remote file and update local file', async () => {
    // 1. Setup local file and state
    const file = { path: 'test.md', name: 'test.md', extension: 'md' };
    mockFiles.push(file);
    fileContents['test.md'] = 'old content';

    const existingState = {
      files: {
        'test.md': {
          hash: CryptoJS.MD5('old content').toString(),
          driveFileId: 'driveId123',
          lastSyncTime: Date.now(),
          deleted: false,
        },
      },
    };
    adapterFiles['.obsidian/plugins/obsidian_drive_sync/sync_state.json'] = JSON.stringify(existingState);

    // Mock Drive list and download
    mockDriveClient.listFilesInFolder = vi.fn().mockResolvedValue([
      { id: 'driveId123', name: 'test.md', mimeType: 'text/markdown', md5Checksum: CryptoJS.MD5('new content').toString() }
    ]);
    mockDriveClient.downloadFile = vi.fn().mockResolvedValue(new TextEncoder().encode('new content').buffer);

    // 2. Run sync
    await syncManager.runSync('destId');

    // 3. Assertions
    expect(fileContents['test.md']).toBe('new content');
    const savedState = JSON.parse(adapterFiles['.obsidian/plugins/obsidian_drive_sync/sync_state.json'] || '{}');
    expect(savedState.files['test.md'].hash).toBe(CryptoJS.MD5('new content').toString());
  });

  it('should merge conflicts inline with Git-style conflict markers and sync back to Drive', async () => {
    // 1. Setup local file and state
    const file = { path: 'test.md', name: 'test.md', extension: 'md' };
    mockFiles.push(file);
    fileContents['test.md'] = 'local content';

    const existingState = {
      files: {
        'test.md': {
          hash: 'differentEntryHash',
          driveFileId: 'driveId123',
          lastSyncTime: Date.now(),
          deleted: false,
        },
      },
    };
    adapterFiles['.obsidian/plugins/obsidian_drive_sync/sync_state.json'] = JSON.stringify(existingState);

    // Mock Drive
    mockDriveClient.listFilesInFolder = vi.fn().mockResolvedValue([
      { id: 'driveId123', name: 'test.md', mimeType: 'text/markdown', md5Checksum: CryptoJS.MD5('remote content').toString() }
    ]);
    mockDriveClient.downloadFile = vi.fn().mockResolvedValue(new TextEncoder().encode('remote content').buffer);
    mockDriveClient.updateFileContent = vi.fn().mockResolvedValue(undefined);

    // 2. Run sync
    await syncManager.runSync('destId');

    // 3. Assertions
    const expectedMerged = [
      '<<<<<<< Local Changes',
      'local content',
      '=======',
      'remote content',
      '>>>>>>> Remote Changes'
    ].join('\n');

    expect(fileContents['test.md']).toBe(expectedMerged);
    expect(mockDriveClient.updateFileContent).toHaveBeenCalledWith('driveId123', expectedMerged);

    const savedState = JSON.parse(adapterFiles['.obsidian/plugins/obsidian_drive_sync/sync_state.json'] || '{}');
    expect(savedState.files['test.md'].hash).toBe(CryptoJS.MD5(expectedMerged).toString());
  });

  it('should rename local file when remote rename/move is detected', async () => {
    // 1. Setup local file and state
    const file = { path: 'FolderA/test.md', name: 'test.md', extension: 'md' };
    mockFiles.push(file);
    fileContents['FolderA/test.md'] = 'content';

    const existingState = {
      files: {
        'FolderA/test.md': {
          hash: CryptoJS.MD5('content').toString(),
          driveFileId: 'driveId123',
          lastSyncTime: Date.now(),
          deleted: false,
        },
      },
    };
    adapterFiles['.obsidian/plugins/obsidian_drive_sync/sync_state.json'] = JSON.stringify(existingState);

    // Mock listFilesInFolder for recursive BFS mapping
    mockDriveClient.listFilesInFolder = vi.fn().mockImplementation(async (folderId) => {
      if (folderId === 'destId') {
        return [
          { id: 'folderB_Id', name: 'FolderB', mimeType: 'application/vnd.google-apps.folder' }
        ];
      }
      if (folderId === 'folderB_Id') {
        return [
          { id: 'driveId123', name: 'test.md', mimeType: 'text/markdown', md5Checksum: CryptoJS.MD5('content').toString() }
        ];
      }
      return [];
    });

    // 2. Run sync
    await syncManager.runSync('destId');

    // 3. Assertions
    expect(mockApp.vault.rename).toHaveBeenCalled();
    expect(fileContents['FolderB/test.md']).toBe('content');
    expect(fileContents['FolderA/test.md']).toBeUndefined();

    const savedState = JSON.parse(adapterFiles['.obsidian/plugins/obsidian_drive_sync/sync_state.json'] || '{}');
    expect(savedState.files['FolderA/test.md']).toBeUndefined();
    expect(savedState.files['FolderB/test.md']).toBeDefined();
    expect(savedState.files['FolderB/test.md'].driveFileId).toBe('driveId123');
  });

  it('should detect remote changes first and resolve conflict on single file incremental sync', async () => {
    // 1. Setup local file and state
    const file = { path: 'conflict.md', name: 'conflict.md', extension: 'md' };
    mockFiles.push(file);
    fileContents['conflict.md'] = 'local changes';

    const existingState = {
      files: {
        'conflict.md': {
          hash: CryptoJS.MD5('original content').toString(),
          driveFileId: 'driveId123',
          lastSyncTime: Date.now(),
          deleted: false,
        },
      },
    };
    adapterFiles['.obsidian/plugins/obsidian_drive_sync/sync_state.json'] = JSON.stringify(existingState);

    // Mock Google Drive client to return remote modified version
    mockDriveClient.resolveFolderHierarchy.mockResolvedValue('destId');
    mockDriveClient.findItem.mockResolvedValue({
      id: 'driveId123',
      name: 'conflict.md',
      mimeType: 'text/markdown',
      md5Checksum: CryptoJS.MD5('remote changes').toString()
    });
    mockDriveClient.getFileMetadata.mockResolvedValue({
      id: 'driveId123',
      name: 'conflict.md',
      mimeType: 'text/markdown',
      md5Checksum: CryptoJS.MD5('remote changes').toString(),
      trashed: false
    });
    mockDriveClient.downloadFile.mockResolvedValue(new TextEncoder().encode('remote changes').buffer);
    mockDriveClient.updateFileContent.mockResolvedValue(undefined);

    // 2. Run single file sync
    await syncManager.syncSingleFile(file as any, 'destId');

    // 3. Assertions
    // It should have merged local and remote changes inline
    const expectedMerged = [
      '<<<<<<< Local Changes',
      'local changes',
      '=======',
      'remote changes',
      '>>>>>>> Remote Changes'
    ].join('\n');

    expect(fileContents['conflict.md']).toBe(expectedMerged);
    expect(mockDriveClient.updateFileContent).toHaveBeenCalledWith('driveId123', expectedMerged);

    const savedState = JSON.parse(adapterFiles['.obsidian/plugins/obsidian_drive_sync/sync_state.json'] || '{}');
    expect(savedState.files['conflict.md'].hash).toBe(CryptoJS.MD5(expectedMerged).toString());
  });

  it('should detect untracked conflict and resolve on single file incremental sync', async () => {
    // 1. Setup local file (no state)
    const file = { path: 'untracked_conflict.md', name: 'untracked_conflict.md', extension: 'md' };
    mockFiles.push(file);
    fileContents['untracked_conflict.md'] = 'local changes';

    // Mock Google Drive client to return remote version
    mockDriveClient.resolveFolderHierarchy.mockResolvedValue('destId');
    mockDriveClient.findItem.mockResolvedValue({
      id: 'driveId123',
      name: 'untracked_conflict.md',
      mimeType: 'text/markdown',
      md5Checksum: CryptoJS.MD5('remote changes').toString()
    });
    mockDriveClient.downloadFile.mockResolvedValue(new TextEncoder().encode('remote changes').buffer);
    mockDriveClient.updateFileContent.mockResolvedValue(undefined);

    // 2. Run single file sync
    await syncManager.syncSingleFile(file as any, 'destId');

    // 3. Assertions
    const expectedMerged = [
      '<<<<<<< Local Changes',
      'local changes',
      '=======',
      'remote changes',
      '>>>>>>> Remote Changes'
    ].join('\n');

    expect(fileContents['untracked_conflict.md']).toBe(expectedMerged);
    expect(mockDriveClient.updateFileContent).toHaveBeenCalledWith('driveId123', expectedMerged);
  });

  it('should rename local binary file to a hidden path starting with a dot on conflict', async () => {
    // 1. Setup local binary file and state
    const file = { path: 'FolderA/image.png', name: 'image.png', extension: 'png' };
    mockFiles.push(file);
    const localContent = new Uint8Array([1, 2, 3]).buffer;
    fileContents['FolderA/image.png'] = localContent;

    const existingState = {
      files: {
        'FolderA/image.png': {
          hash: CryptoJS.MD5('original content').toString(),
          driveFileId: 'driveId123',
          lastSyncTime: Date.now(),
          deleted: false,
        },
      },
    };
    adapterFiles['.obsidian/plugins/obsidian_drive_sync/sync_state.json'] = JSON.stringify(existingState);

    // Setup listFilesInFolder to return remote modified version
    mockDriveClient.listFilesInFolder = vi.fn().mockImplementation(async (folderId) => {
      if (folderId === 'destId') {
        return [
          { id: 'folderA_Id', name: 'FolderA', mimeType: 'application/vnd.google-apps.folder' }
        ];
      }
      if (folderId === 'folderA_Id') {
        return [
          { id: 'driveId123', name: 'image.png', mimeType: 'image/png', md5Checksum: CryptoJS.MD5('remote binary content').toString() }
        ];
      }
      return [];
    });

    const remoteContent = new Uint8Array([4, 5, 6]).buffer;
    mockDriveClient.downloadFile = vi.fn().mockResolvedValue(remoteContent);

    // 2. Run sync
    await syncManager.runSync('destId');

    // 3. Assertions
    // The conflict path must start with a dot for the filename segment: FolderA/.image.sync-conflict.png
    const expectedConflictPath = 'FolderA/.image.sync-conflict.png';
    expect(mockApp.vault.rename).toHaveBeenCalledWith(expect.anything(), expectedConflictPath);
    expect(fileContents[expectedConflictPath]).toBe(localContent);
    expect(fileContents['FolderA/image.png']).toBe(remoteContent);

    const savedState = JSON.parse(adapterFiles['.obsidian/plugins/obsidian_drive_sync/sync_state.json'] || '{}');
    expect(savedState.files[expectedConflictPath]).toBeDefined();
    expect(savedState.files[expectedConflictPath].driveFileId).toBe('');
    expect(savedState.files['FolderA/image.png'].driveFileId).toBe('driveId123');
  });

  it('should serialize concurrent sync calls on the same file path using withPathLock', async () => {
    vi.useFakeTimers();

    // 1. Setup file
    const file = { path: 'lock-test.md', name: 'lock-test.md', extension: 'md' };
    mockFiles.push(file);
    fileContents['lock-test.md'] = 'content v1';

    let activeCallCount = 0;
    let maxConcurrentCalls = 0;
    let p2Promise: Promise<void> | null = null;

    mockDriveClient.resolveFolderHierarchy.mockResolvedValue('destId');
    mockDriveClient.findItem.mockImplementation(async (fileName: string, folderId: string, isFolder: boolean) => {
      // In the first check of createFile it won't exist. On retry, return the created file metadata
      const hasState = !!JSON.parse(adapterFiles['.obsidian/plugins/obsidian_drive_sync/sync_state.json'] || '{}').files?.['lock-test.md'];
      if (hasState) {
        return { id: 'driveFileId123', name: 'lock-test.md', mimeType: 'text/markdown', md5Checksum: CryptoJS.MD5('content v1').toString() };
      }
      return null;
    });

    mockDriveClient.getFileMetadata.mockResolvedValue({
      id: 'driveFileId123',
      name: 'lock-test.md',
      mimeType: 'text/markdown',
      md5Checksum: CryptoJS.MD5('content v1').toString(),
      trashed: false
    });
    
    mockDriveClient.createFile = vi.fn().mockImplementation(async () => {
      activeCallCount++;
      maxConcurrentCalls = Math.max(maxConcurrentCalls, activeCallCount);

      // Trigger modification and second sync call while p1 is active
      fileContents['lock-test.md'] = 'content v2';
      p2Promise = syncManager.syncSingleFile(file as any, 'destId');

      await new Promise(resolve => setTimeout(resolve, 50));
      activeCallCount--;
      return 'driveFileId123';
    });

    // 2. Trigger first sync call
    const p1 = syncManager.syncSingleFile(file as any, 'destId');

    // Fast forward the first createFile's timer
    await vi.advanceTimersByTimeAsync(50);
    await p1;

    // By now p2Promise should have completed its immediate execution (locked)
    expect(p2Promise).toBeDefined();
    await p2Promise;

    // The second call was skipped and added to needsRetry.
    // In finally, it calls debounceSyncFile, which sets a 5000ms timer.
    // Let's fast forward 5000ms to trigger the retry sync!
    await vi.advanceTimersByTimeAsync(5000);

    // 3. Assertions
    expect(maxConcurrentCalls).toBe(1);
    // First run calls createFile. Second run calls updateFileContent (not createFile)
    expect(mockDriveClient.createFile).toHaveBeenCalledTimes(1);
    expect(mockDriveClient.updateFileContent).toHaveBeenCalledWith('driveFileId123', 'content v2');

    vi.useRealTimers();
  });

  it('should prune empty local folders recursively, ignoring root, dot-folders, and non-empty folders', async () => {
    // 1. Setup mock folders
    mockFolders.push(
      { path: 'folderA', name: 'folderA' },
      { path: 'folderA/folderB', name: 'folderB' },
      { path: 'folderA/folderB/folderC', name: 'folderC' },
      { path: 'folderD', name: 'folderD' },
      { path: '.obsidian', name: '.obsidian' },
      { path: '.obsidian/somefolder', name: 'somefolder' },
      { path: '.git', name: '.git' }
    );

    mockFiles.push(
      { path: 'folderD/file1.md', name: 'file1.md', extension: 'md' }
    );

    // 2. Call pruneEmptyLocalFolders
    const prunedCount = await syncManager.pruneEmptyLocalFolders();

    // 3. Assertions
    expect(prunedCount).toBe(3);

    const paths = mockFolders.map(f => f.path);
    expect(paths).toContain('folderD');
    expect(paths).toContain('.obsidian');
    expect(paths).toContain('.obsidian/somefolder');
    expect(paths).toContain('.git');
    expect(paths).not.toContain('folderA');
    expect(paths).not.toContain('folderA/folderB');
    expect(paths).not.toContain('folderA/folderB/folderC');
  });

  it('should prune empty local folders only under a specified rootPath', async () => {
    // 1. Setup mock folders
    mockFolders.push(
      { path: 'folderA', name: 'folderA' },
      { path: 'folderA/folderB', name: 'folderB' },
      { path: 'folderX', name: 'folderX' },
      { path: 'folderX/folderY', name: 'folderY' }
    );

    // 2. Call pruneEmptyLocalFolders with 'folderA' as rootPath
    const prunedCount = await syncManager.pruneEmptyLocalFolders('folderA');

    // 3. Assertions
    expect(prunedCount).toBe(2);

    const paths = mockFolders.map(f => f.path);
    expect(paths).toContain('folderX');
    expect(paths).toContain('folderX/folderY');
    expect(paths).not.toContain('folderA');
    expect(paths).not.toContain('folderA/folderB');
  });
});
