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
      manifest = { id: 'logging-plugin' };
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
        id: 'logging-plugin',
      },
    };

    // Mock GoogleDriveClient
    mockDriveClient = {
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
    adapterFiles['.obsidian/plugins/logging-plugin/sync_state.json'] = JSON.stringify(existingState);

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
    const savedState = JSON.parse(adapterFiles['.obsidian/plugins/logging-plugin/sync_state.json'] || '{}');
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
    adapterFiles['.obsidian/plugins/logging-plugin/sync_state.json'] = JSON.stringify(existingState);

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
    adapterFiles['.obsidian/plugins/logging-plugin/sync_state.json'] = JSON.stringify(existingState);

    // 2. Google Drive mocks
    mockDriveClient.resolveFolderHierarchy.mockResolvedValue('driveFolderId');
    mockDriveClient.findItem.mockResolvedValue({ id: 'id123' }); // File exists on Drive

    // 3. Run sync
    await syncManager.runSync('destinationFolderId');

    // 4. Assertions
    expect(mockDriveClient.updateFileContent).toHaveBeenCalledWith('id123', newContent);
    
    const savedState = JSON.parse(adapterFiles['.obsidian/plugins/logging-plugin/sync_state.json'] || '{}');
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
    adapterFiles['.obsidian/plugins/logging-plugin/sync_state.json'] = JSON.stringify(existingState);

    // 2. Run sync
    await syncManager.runSync('destinationFolderId');

    // 3. Assertions
    const savedState = JSON.parse(adapterFiles['.obsidian/plugins/logging-plugin/sync_state.json'] || '{}');
    expect(savedState.files['deleted_file.md'].deleted).toBe(true);
    expect(mockDriveClient.createFile).not.toHaveBeenCalled();
    expect(mockDriveClient.updateFileContent).not.toHaveBeenCalled();
  });
});
