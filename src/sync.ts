import { App, TFile, TFolder, Notice, Plugin } from 'obsidian';
import * as CryptoJS from 'crypto-js';
import { GoogleDriveClient } from './google';
import { DeleteConfirmationModal } from './ui/delete-modal';

export interface SyncEntry {
  hash: string;
  driveFileId: string;
  lastSyncTime: number;
  deleted?: boolean;
}

export interface SyncState {
  files: Record<string, SyncEntry>;
}

export class SyncManager {
  private app: App;
  private plugin: Plugin;
  private driveClient: GoogleDriveClient;
  private stateFilePath: string;
  private state: SyncState = { files: {} };
  private debounceTimers: Map<string, any> = new Map();
  private lastGlobalDeleteChoice: 'delete' | 'skip' | null = null;
  private lastGlobalDeleteChoiceTime = 0;
  private activeSyncs: Set<string> = new Set();
  private needsRetry: Set<string> = new Set();

  constructor(app: App, plugin: Plugin, driveClient: GoogleDriveClient) {
    this.app = app;
    this.plugin = plugin;
    this.driveClient = driveClient;
    const pluginDir = (this.plugin.manifest as any).dir || `${this.app.vault.configDir}/plugins/${this.plugin.manifest.id}`;
    this.stateFilePath = `${pluginDir}/sync_state.json`;
  }

  // Show a confirmation modal for local file deletion
  private askDeleteChoice(fileName: string): Promise<{ choice: 'delete' | 'skip', applyToAll: boolean }> {
    return new Promise((resolve) => {
      const modal = new DeleteConfirmationModal(this.app, fileName, (choice, applyToAll) => {
        resolve({ choice, applyToAll });
      });
      modal.open();
    });
  }

  // Recursively fetch all remote files under a root folder ID, computing paths relative to root
  private async getAllRemoteFiles(rootFolderId: string, pathPrefix = ''): Promise<Map<string, any>> {
    const remoteFiles = new Map<string, any>();
    const queue = [{ id: rootFolderId, path: pathPrefix }];
    
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) continue;
      
      const items = await this.driveClient.listFilesInFolder(current.id);
      for (const item of items) {
        if (item.mimeType === 'application/vnd.google-apps.folder') {
          queue.push({
            id: item.id,
            path: current.path ? `${current.path}/${item.name}` : item.name
          });
        } else {
          const itemPath = current.path ? `${current.path}/${item.name}` : item.name;
          remoteFiles.set(item.id, {
            ...item,
            computedPath: itemPath
          });
        }
      }
    }
    return remoteFiles;
  }

  // Recursively ensure a directory exists locally in the Obsidian vault
  private async ensureLocalDirectory(dirPath: string): Promise<void> {
    if (!dirPath) return;
    const parts = dirPath.split('/');
    let currentPath = '';
    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const exists = await this.app.vault.adapter.exists(currentPath);
      if (!exists) {
        try {
          await this.app.vault.createFolder(currentPath);
          if (DEBUG_LOGGING) {
            console.log(`Created local folder: ${currentPath}`);
          }
        } catch (e) {
          console.error(`Failed to create local folder ${currentPath}:`, e);
        }
      }
    }
  }

  // Construct a hidden conflict path starting with "." for the filename
  private getConflictPath(filePath: string): string {
    const ext = filePath.split('.').pop() || '';
    const pathParts = filePath.split('/');
    const fileNameWithExt = pathParts.pop() || '';
    const parentDir = pathParts.join('/');
    const nameWithoutExt = fileNameWithExt.slice(0, -(ext.length + 1));
    const conflictFileName = `.${nameWithoutExt}.sync-conflict.${ext}`;
    return parentDir ? `${parentDir}/${conflictFileName}` : conflictFileName;
  }

  // Helper to prevent concurrent operations on the same path
  private async withPathLock(path: string, callback: () => Promise<void>): Promise<void> {
    if (this.activeSyncs.has(path)) {
      this.needsRetry.add(path);
      return;
    }

    this.activeSyncs.add(path);
    try {
      await callback();
    } finally {
      this.activeSyncs.delete(path);
      if (this.needsRetry.has(path)) {
        this.needsRetry.delete(path);
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) {
          const pluginSettings = (this.plugin as any).settings;
          const dest = pluginSettings.destinationFolderId || pluginSettings.destinationFolderName;
          this.debounceSyncFile(file, dest);
        }
      }
    }
  }

  // Determine if a file path is considered a binary file
  private isBinaryFile(path: string): boolean {
    const ext = path.split('.').pop()?.toLowerCase() || '';
    const textExtensions = ['md', 'txt', 'canvas', 'json', 'css', 'js', 'ts'];
    return !textExtensions.includes(ext);
  }

  // Write content to a local file (ensuring directories exist and handling binary vs text)
  private async writeLocalFile(path: string, arrayBuffer: ArrayBuffer, isBinary: boolean): Promise<void> {
    const pathParts = path.split('/');
    pathParts.pop(); // Remove filename to get dir path
    if (pathParts.length > 0) {
      await this.ensureLocalDirectory(pathParts.join('/'));
    }

    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      if (isBinary) {
        await this.app.vault.modifyBinary(file, arrayBuffer);
      } else {
        const text = new TextDecoder().decode(arrayBuffer);
        await this.app.vault.modify(file, text);
      }
    } else {
      // Check if it exists on disk to prevent "file already exists" errors
      const diskExists = await this.app.vault.adapter.exists(path);
      if (diskExists) {
        if (isBinary) {
          await this.app.vault.adapter.writeBinary(path, arrayBuffer);
        } else {
          const text = new TextDecoder().decode(arrayBuffer);
          await this.app.vault.adapter.write(path, text);
        }
      } else {
        if (isBinary) {
          await this.app.vault.createBinary(path, arrayBuffer);
        } else {
          const text = new TextDecoder().decode(arrayBuffer);
          await this.app.vault.create(path, text);
        }
      }
    }
  }

  // Merge conflicting text changes inline using Git-style conflict markers
  private mergeTextConflicts(localText: string, remoteText: string): string {
    const localLines = localText.split('\n');
    const remoteLines = remoteText.split('\n');

    let prefixCount = 0;
    while (
      prefixCount < localLines.length &&
      prefixCount < remoteLines.length &&
      localLines[prefixCount] === remoteLines[prefixCount]
    ) {
      prefixCount++;
    }

    let suffixCount = 0;
    const maxSuffix = Math.min(localLines.length - prefixCount, remoteLines.length - prefixCount);
    while (
      suffixCount < maxSuffix &&
      localLines[localLines.length - 1 - suffixCount] === remoteLines[remoteLines.length - 1 - suffixCount]
    ) {
      suffixCount++;
    }

    const prefixLines = localLines.slice(0, prefixCount);
    const localConflictLines = localLines.slice(prefixCount, localLines.length - suffixCount);
    const remoteConflictLines = remoteLines.slice(prefixCount, remoteLines.length - suffixCount);
    const suffixLines = localLines.slice(localLines.length - suffixCount);

    return [
      ...prefixLines,
      '<<<<<<< Local Changes',
      ...localConflictLines,
      '=======',
      ...remoteConflictLines,
      '>>>>>>> Remote Changes',
      ...suffixLines
    ].join('\n');
  }

  // Helper to compute MD5 hash of raw string or ArrayBuffer content
  private getHashFromContent(content: string | ArrayBuffer, isBinary: boolean): string {
    if (isBinary) {
      const buffer = content instanceof ArrayBuffer ? content : new TextEncoder().encode(content).buffer;
      const wordArray = this.arrayBufferToWordArray(buffer);
      return CryptoJS.MD5(wordArray).toString();
    } else {
      const text = typeof content === 'string' ? content : new TextDecoder().decode(content);
      const normalizedText = text.replace(/\r\n/g, '\n');
      return CryptoJS.MD5(normalizedText).toString();
    }
  }

  // Load state from local file
  public async loadState(): Promise<void> {
    try {
      const exists = await this.app.vault.adapter.exists(this.stateFilePath);
      if (exists) {
        const content = await this.app.vault.adapter.read(this.stateFilePath);
        this.state = JSON.parse(content);
        if (!this.state.files) {
          this.state.files = {};
        }
      } else {
        this.state = { files: {} };
      }
    } catch (e) {
      console.error("Failed to load sync state. Initializing empty state.", e);
      this.state = { files: {} };
    }
  }

  // Save state incrementally
  public async saveState(): Promise<void> {
    try {
      await this.app.vault.adapter.write(this.stateFilePath, JSON.stringify(this.state, null, 2));
    } catch (e) {
      console.error("Failed to save sync state:", e);
    }
  }

  // Helper to convert ArrayBuffer to CryptoJS WordArray
  private arrayBufferToWordArray(ab: ArrayBuffer): CryptoJS.lib.WordArray {
    const i8a = new Uint8Array(ab);
    const words: number[] = [];
    for (let i = 0; i < i8a.length; i += 4) {
      const b0 = i8a[i] ?? 0;
      const b1 = i8a[i + 1] ?? 0;
      const b2 = i8a[i + 2] ?? 0;
      const b3 = i8a[i + 3] ?? 0;
      words.push((b0 << 24) | (b1 << 16) | (b2 << 8) | b3);
    }
    return CryptoJS.lib.WordArray.create(words, i8a.length);
  }

  // Helper to compute MD5 hash of TFile
  private async getFileHash(file: TFile): Promise<{ hash: string; isBinary: boolean; content: string | ArrayBuffer }> {
    const isBinary = this.isBinaryFile(file.path);

    if (isBinary) {
      const buffer = await this.app.vault.readBinary(file);
      const wordArray = this.arrayBufferToWordArray(buffer);
      const hash = CryptoJS.MD5(wordArray).toString();
      return { hash, isBinary, content: buffer };
    } else {
      const text = await this.app.vault.read(file);
      const normalizedText = text.replace(/\r\n/g, '\n');
      const hash = CryptoJS.MD5(normalizedText).toString();
      return { hash, isBinary, content: normalizedText };
    }
  }

  // Verify and resolve/create destination folder ID
  public async resolveDestinationFolderId(destinationFolderId: string): Promise<string | null> {
    if (!destinationFolderId || destinationFolderId.trim() === '' || destinationFolderId.trim() === '.') {
      return null;
    }

    const pluginSettings = (this.plugin as any).settings;
    let resolvedFolderId = destinationFolderId;
    
    // Check if the destination folder exists by ID and fetch its metadata
    let folderMeta = await this.driveClient.getFolderMetadata(resolvedFolderId);
    
    // If it doesn't exist by ID, but it was our cached ID, warn the user and fallback to name lookup
    if (!folderMeta && pluginSettings && pluginSettings.destinationFolderId === resolvedFolderId) {
      const errMsg = `Google Drive folder with ID "${resolvedFolderId}" was not found (it may have been deleted). Resetting and re-resolving by name...`;
      new Notice(errMsg);
      console.warn(errMsg);
      
      pluginSettings.destinationFolderId = '';
      if (typeof (this.plugin as any).saveSettings === 'function') {
        await (this.plugin as any).saveSettings();
      }
      
      // Fallback to name or root
      resolvedFolderId = pluginSettings.destinationFolderName || 'root';
      folderMeta = await this.driveClient.getFolderMetadata(resolvedFolderId);
    }

    if (!folderMeta) {
      if (DEBUG_LOGGING) {
        console.log(`Destination folder ID/name "${resolvedFolderId}" not found on Google Drive. Resolving...`);
      }
      const existingFolder = await this.driveClient.findItem(resolvedFolderId, 'root', true);
      if (existingFolder) {
        resolvedFolderId = existingFolder.id;
        if (DEBUG_LOGGING) {
          console.log(`Found existing folder "${resolvedFolderId}" with ID: ${resolvedFolderId}`);
        }
      } else {
        try {
          resolvedFolderId = await this.driveClient.createFolder(resolvedFolderId, 'root');
          if (DEBUG_LOGGING) {
            console.log(`Created new destination folder "${resolvedFolderId}" with ID: ${resolvedFolderId}`);
          }
        } catch (createErr) {
          const errDetails = createErr instanceof Error ? createErr.message : String(createErr);
          const errMsg = `Failed to create destination folder "${resolvedFolderId}" on Google Drive: ${errDetails}`;
          new Notice(errMsg);
          console.error(errMsg);
          return null;
        }
      }

      // Update plugin settings with the resolved folder ID to avoid future lookups
      if (pluginSettings) {
        pluginSettings.destinationFolderId = resolvedFolderId;
        if (typeof (this.plugin as any).saveSettings === 'function') {
          await (this.plugin as any).saveSettings();
        }
      }
    } else {
      // Folder exists! Check if its name matches the configured folder name and rename if necessary
      if (folderMeta.id !== 'root' && pluginSettings && pluginSettings.destinationFolderName && folderMeta.name !== pluginSettings.destinationFolderName) {
        if (DEBUG_LOGGING) {
          console.log(`Folder name mismatch on Google Drive. Renaming folder "${folderMeta.name}" (ID: ${folderMeta.id}) to "${pluginSettings.destinationFolderName}" to keep in sync.`);
        }
        try {
          await this.driveClient.renameItem(folderMeta.id, pluginSettings.destinationFolderName);
        } catch (renameErr) {
          console.error(`Failed to sync folder name on Google Drive:`, renameErr);
        }
      }
    }

    return resolvedFolderId;
  }

  // Core logic to upload or update a file, returning its Drive ID
  private async syncFileCore(file: TFile, resolvedFolderId: string, entry: SyncEntry | undefined): Promise<string> {
    const { content } = await this.getFileHash(file);
    const pathParts = file.path.split('/');
    const fileName = pathParts.pop() || file.name;
    const parentFolderId = await this.driveClient.resolveFolderHierarchy(pathParts, resolvedFolderId);

    let driveFileId = entry?.driveFileId || '';

    // If we have a cached file ID, verify it exists on Google Drive
    if (driveFileId) {
      const driveItem = await this.driveClient.findItem(fileName, parentFolderId, false);
      if (driveItem) {
        driveFileId = driveItem.id;
      } else {
        driveFileId = ''; // Reset to trigger creation if it was deleted on Drive
      }
    } else {
      // Check if file exists on Drive with same name and parent
      const driveItem = await this.driveClient.findItem(fileName, parentFolderId, false);
      if (driveItem) {
        driveFileId = driveItem.id;
      }
    }

    if (driveFileId) {
      // Update existing file content
      await this.driveClient.updateFileContent(driveFileId, content);
      if (DEBUG_LOGGING) {
        console.log(`Updated file content on Drive: ${file.path}`);
      }
    } else {
      // Create new file on Drive
      driveFileId = await this.driveClient.createFile(fileName, parentFolderId, content);
      if (DEBUG_LOGGING) {
        console.log(`Created new file on Drive: ${file.path}`);
      }
    }

    return driveFileId;
  }

  // Synchronize a single file incrementally
  public async syncSingleFile(file: TFile, resolvedFolderId: string): Promise<void> {
    const pathParts = file.path.split('/');
    if (pathParts.some(part => part.startsWith('.'))) return;

    await this.withPathLock(file.path, async () => {
      // Verify the file still exists locally before proceeding
      const localFile = this.app.vault.getAbstractFileByPath(file.path);
      if (!(localFile instanceof TFile)) {
        if (DEBUG_LOGGING) {
          console.info(`syncSingleFile: File no longer exists locally, skipping sync: ${file.path}`);
        }
        return;
      }

      await this.loadState();
      const entry = this.state.files[file.path];
      const { hash: localHash, isBinary, content: localContent } = await this.getFileHash(file);

      // Skip if already synced and unchanged
      if (entry && entry.hash === localHash && !entry.deleted) {
        return;
      }

      if (DEBUG_LOGGING) {
        if (!entry) {
          console.info(`Incremental sync: unseen file (new locally): ${file.path}`);
        } else if (entry.deleted) {
          console.info(`Incremental sync: restored file (previously marked as deleted): ${file.path}`);
        } else if (entry.hash !== localHash) {
          console.info(`Incremental sync: modified file (hash mismatch): ${file.path}`);
        }
        console.log(`Incremental sync: syncing file: ${file.path}`);
      }

      // Check Google Drive for changes first to avoid overwriting remote changes
      let conflictResolved = false;
      try {
        const parentParts = [...pathParts];
        const fileName = parentParts.pop() || file.name;
        const parentFolderId = await this.driveClient.resolveFolderHierarchy(parentParts, resolvedFolderId);
        const remoteFile = await this.driveClient.findItem(fileName, parentFolderId, false);

        if (remoteFile && !remoteFile.trashed) {
          const remoteHash = remoteFile.md5Checksum;
          
          if (entry) {
            const entryHash = entry.hash;
            if (remoteHash !== entryHash && localHash !== entryHash) {
              // Case 1 Conflict: Both modified since last sync
              if (DEBUG_LOGGING) {
                console.log(`Incremental sync conflict detected for ${file.path}. Merging changes.`);
              }
              if (!isBinary) {
                const remoteBuffer = await this.driveClient.downloadFile(remoteFile.id);
                const remoteText = new TextDecoder().decode(remoteBuffer);
                const mergedText = this.mergeTextConflicts(localContent as string, remoteText);
                
                await this.app.vault.modify(file, mergedText);
                await this.driveClient.updateFileContent(remoteFile.id, mergedText);
                
                const mergedHash = CryptoJS.MD5(mergedText).toString();
                this.state.files[file.path] = {
                  hash: mergedHash,
                  driveFileId: remoteFile.id,
                  lastSyncTime: Date.now(),
                  deleted: false
                };
                await this.saveState();
              } else {
                const conflictPath = this.getConflictPath(file.path);
                
                await this.ensureLocalDirectory(parentParts.join('/'));
                await this.app.vault.rename(file, conflictPath);
                
                const remoteBuffer = await this.driveClient.downloadFile(remoteFile.id);
                await this.writeLocalFile(file.path, remoteBuffer, true);
                
                const remoteHashCalculated = this.getHashFromContent(remoteBuffer, true);
                this.state.files[file.path] = {
                  hash: remoteHashCalculated,
                  driveFileId: remoteFile.id,
                  lastSyncTime: Date.now(),
                  deleted: false
                };
                this.state.files[conflictPath] = {
                  hash: localHash,
                  driveFileId: '',
                  lastSyncTime: Date.now(),
                  deleted: false
                };
                await this.saveState();
              }
              conflictResolved = true;
            }
          } else {
            // Untracked conflict (exists locally and remotely, but not in state cache)
            if (localHash !== remoteHash) {
              if (DEBUG_LOGGING) {
                console.log(`Incremental sync untracked conflict detected for ${file.path}. Merging changes.`);
              }
              if (!isBinary) {
                const remoteBuffer = await this.driveClient.downloadFile(remoteFile.id);
                const remoteText = new TextDecoder().decode(remoteBuffer);
                const mergedText = this.mergeTextConflicts(localContent as string, remoteText);
                
                await this.app.vault.modify(file, mergedText);
                await this.driveClient.updateFileContent(remoteFile.id, mergedText);
                
                const mergedHash = CryptoJS.MD5(mergedText).toString();
                this.state.files[file.path] = {
                  hash: mergedHash,
                  driveFileId: remoteFile.id,
                  lastSyncTime: Date.now(),
                  deleted: false
                };
                await this.saveState();
              } else {
                const conflictPath = this.getConflictPath(file.path);
                
                await this.ensureLocalDirectory(parentParts.join('/'));
                await this.app.vault.rename(file, conflictPath);
                
                const remoteBuffer = await this.driveClient.downloadFile(remoteFile.id);
                await this.writeLocalFile(file.path, remoteBuffer, true);
                
                const remoteHashCalculated = this.getHashFromContent(remoteBuffer, true);
                this.state.files[file.path] = {
                  hash: remoteHashCalculated,
                  driveFileId: remoteFile.id,
                  lastSyncTime: Date.now(),
                  deleted: false
                };
                this.state.files[conflictPath] = {
                  hash: localHash,
                  driveFileId: '',
                  lastSyncTime: Date.now(),
                  deleted: false
                };
                await this.saveState();
              }
              conflictResolved = true;
            } else {
              // Unchanged/hashes match. Simply register in state cache
              this.state.files[file.path] = {
                hash: localHash,
                driveFileId: remoteFile.id,
                lastSyncTime: Date.now(),
                deleted: false
              };
              await this.saveState();
              conflictResolved = true;
            }
          }
        }
      } catch (checkErr) {
        console.warn(`Failed remote pre-check for incremental sync of ${file.path}:`, checkErr);
      }

      if (!conflictResolved) {
        const driveFileId = await this.syncFileCore(file, resolvedFolderId, entry);

        this.state.files[file.path] = {
          hash: localHash,
          driveFileId: driveFileId,
          lastSyncTime: Date.now(),
          deleted: false,
          };

        await this.saveState();
      }
    });
  }

  // Debounce sync of a single file to avoid spamming calls during typing
  public debounceSyncFile(file: TFile, destinationFolderId: string): void {
    if (!destinationFolderId || destinationFolderId.trim() === '' || destinationFolderId.trim() === '.') {
      return;
    }

    const filePath = file.path;
    const existingTimer = this.debounceTimers.get(filePath);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(async () => {
      this.debounceTimers.delete(filePath);
      try {
        const resolvedFolderId = await this.resolveDestinationFolderId(destinationFolderId);
        if (resolvedFolderId) {
          await this.syncSingleFile(file, resolvedFolderId);
        }
      } catch (err) {
        console.error(`Incremental sync failed for ${filePath}:`, err);
      }
    }, 5000); // 5 seconds debounce delay

    this.debounceTimers.set(filePath, timer);
  }

  // Handle a local deletion event immediately
  public async handleLocalDeletion(path: string): Promise<void> {
    const pathParts = path.split('/');
    if (pathParts.some(part => part.startsWith('.'))) return;

    await this.withPathLock(path, async () => {
      // Cancel any pending debounced sync
      const existingTimer = this.debounceTimers.get(path);
      if (existingTimer) {
        clearTimeout(existingTimer);
        this.debounceTimers.delete(path);
      }

      await this.loadState();
      const entry = this.state.files[path];
      if (entry && !entry.deleted) {
        if (DEBUG_LOGGING) {
          console.info(`Incremental sync: local deletion detected for ${path}`);
        }
        
        const driveFileId = entry.driveFileId;
        entry.deleted = true;
        entry.lastSyncTime = Date.now();
        await this.saveState();

        if (driveFileId) {
          try {
            const meta = await this.driveClient.getFileMetadata(driveFileId);
            if (meta && !meta.trashed) {
              let choice: 'delete' | 'skip' = 'skip';
              const now = Date.now();

              if (this.lastGlobalDeleteChoice && (now - this.lastGlobalDeleteChoiceTime < 10000)) {
                choice = this.lastGlobalDeleteChoice;
              } else {
                this.lastGlobalDeleteChoice = null;
                const result = await this.askDeleteChoice(path);
                choice = result.choice;
                if (result.applyToAll) {
                  this.lastGlobalDeleteChoice = choice;
                  this.lastGlobalDeleteChoiceTime = now;
                }
              }

              if (choice === 'delete') {
                if (DEBUG_LOGGING) {
                  console.info(`Applying deletion on Google Drive for: ${path}`);
                }
                await this.driveClient.deleteItem(driveFileId);
              } else {
                if (DEBUG_LOGGING) {
                  console.info(`Skipping deletion on Google Drive for: ${path}`);
                }
                await this.loadState();
                if (this.state.files[path]) {
                  this.state.files[path].driveFileId = '';
                  await this.saveState();
                }
              }
            }
          } catch (e) {
            console.error(`Failed to propagate deletion for ${path} on Google Drive:`, e);
          }
        }
      }
    });
  }

  // Handle a local rename/move event immediately
  public async handleLocalRename(oldPath: string, file: TFile, destinationFolderId: string): Promise<void> {
    if (!destinationFolderId || destinationFolderId.trim() === '' || destinationFolderId.trim() === '.') {
      return;
    }

    // Cancel any pending debounced sync for the old path
    const oldTimer = this.debounceTimers.get(oldPath);
    if (oldTimer) {
      clearTimeout(oldTimer);
      this.debounceTimers.delete(oldPath);
    }

    await this.loadState();
    const oldEntry = this.state.files[oldPath];

    if (DEBUG_LOGGING) {
      console.info(`Incremental sync: file renamed/moved from ${oldPath} to ${file.path}`);
    }

    // If there is no cached Drive ID for the old path, just sync the new file as a fresh create
    if (!oldEntry || !oldEntry.driveFileId) {
      // Mark old path as deleted in state just in case
      await this.handleLocalDeletion(oldPath);
      try {
        const resolvedFolderId = await this.resolveDestinationFolderId(destinationFolderId);
        if (resolvedFolderId) {
          await this.syncSingleFile(file, resolvedFolderId);
        }
      } catch (err) {
        console.error(`Incremental sync failed for renamed file ${file.path}:`, err);
      }
      return;
    }

    const driveFileId = oldEntry.driveFileId;

    try {
      const resolvedFolderId = await this.resolveDestinationFolderId(destinationFolderId);
      if (!resolvedFolderId) {
        throw new Error("Could not resolve destination folder ID");
      }

      // 1. Resolve new parent folder hierarchy on Drive
      const pathParts = file.path.split('/');
      const fileName = pathParts.pop() || file.name;
      const newParentFolderId = await this.driveClient.resolveFolderHierarchy(pathParts, resolvedFolderId);

      // 2. Fetch current parents of the file on Drive
      const parents = await this.driveClient.getFileParents(driveFileId);

      if (parents.length > 0) {
        const oldParentId = parents[0];
        if (oldParentId) {
          if (oldParentId !== newParentFolderId) {
            // Reparent and rename (if name changed too) in one request
            if (DEBUG_LOGGING) {
              console.log(`Reparenting and renaming file ${driveFileId} from parent ${oldParentId} to ${newParentFolderId} with name "${fileName}"`);
            }
            await this.driveClient.moveFile(driveFileId, oldParentId, newParentFolderId, fileName);
          } else {
            // Same parent folder, check if filename changed
            const oldPathParts = oldPath.split('/');
            const oldFileName = oldPathParts.pop() || '';
            if (oldFileName && oldFileName !== fileName) {
              if (DEBUG_LOGGING) {
                console.log(`Renaming file ${driveFileId} from "${oldFileName}" to "${fileName}" under same parent`);
              }
              await this.driveClient.renameItem(driveFileId, fileName);
            }
          }
        }
      } else {
        // Fallback: If parents length is 0 (file might have been orphaned or deleted on Drive),
        // we'll try to find it on Drive or create it.
        if (DEBUG_LOGGING) {
          console.warn(`No parents found on Drive for file ID ${driveFileId}. Re-syncing as a new upload.`);
        }
        await this.syncSingleFile(file, resolvedFolderId);
        return;
      }

      // 3. Sync file contents if they have changed
      const { hash, content } = await this.getFileHash(file);
      if (oldEntry.hash !== hash) {
        if (DEBUG_LOGGING) {
          console.log(`Contents of moved/renamed file ${file.path} changed. Updating content on Google Drive.`);
        }
        await this.driveClient.updateFileContent(driveFileId, content);
      }

      // 4. Update sync state: remove old path, add new path
      delete this.state.files[oldPath];
      this.state.files[file.path] = {
        hash: hash,
        driveFileId: driveFileId,
        lastSyncTime: Date.now(),
        deleted: false,
      };
      await this.saveState();

    } catch (err) {
      console.error(`Failed to move/rename file ${oldPath} to ${file.path} on Google Drive:`, err);
      // Fallback: mark old as deleted, sync new as fresh
      await this.handleLocalDeletion(oldPath);
      try {
        const resolvedFolderId = await this.resolveDestinationFolderId(destinationFolderId);
        if (resolvedFolderId) {
          await this.syncSingleFile(file, resolvedFolderId);
        }
      } catch (fallbackErr) {
        console.error(`Fallback sync failed for renamed file ${file.path}:`, fallbackErr);
      }
    }
  }

  // Find and delete empty local folders in the Obsidian vault recursively
  public async pruneEmptyLocalFolders(rootPath?: string): Promise<number> {
    let prunedCount = 0;
    const allFiles = this.app.vault.getAllLoadedFiles();
    const folders = allFiles.filter((file): file is TFolder => {
      if (!(file instanceof TFolder)) return false;
      if (file.path === '/' || file.path === '' || (typeof file.isRoot === 'function' && file.isRoot())) return false;
      if (rootPath && file.path !== rootPath && !file.path.startsWith(rootPath + '/')) return false;
      const pathParts = file.path.split('/');
      return !pathParts.some(part => part.startsWith('.'));
    });

    // Sort folders by depth in descending order to handle nested empty directories first
    folders.sort((a, b) => b.path.split('/').length - a.path.split('/').length);

    for (const folder of folders) {
      const liveFolder = this.app.vault.getAbstractFileByPath(folder.path);
      if (liveFolder instanceof TFolder && liveFolder.children.length === 0) {
        try {
          await this.app.vault.delete(liveFolder);
          prunedCount++;
          if (DEBUG_LOGGING) {
            console.log(`Pruned empty local folder: ${folder.path}`);
          }
        } catch (e) {
          console.error(`Failed to delete empty local folder ${folder.path}:`, e);
        }
      }
    }
    return prunedCount;
  }

  // Run the full sync operation
  // Run the full sync operation (optionally scoped to a subPath folder)
  public async runSync(destinationFolderId: string, subPath?: string): Promise<void> {
    const pluginAny = this.plugin as any;
    if (pluginAny) {
      pluginAny.lastSyncTime = Date.now();
    }

    if (!destinationFolderId || destinationFolderId.trim() === '') {
      new Notice("Google Drive destination folder ID is not configured. Skipping sync.");
      return;
    }

    if (destinationFolderId.trim() === '.') {
      const errorMsg = "Google Drive destination folder ID is invalid ('.'). To sync to the root of your Google Drive, please set the folder ID to 'root' in the settings.";
      new Notice(errorMsg);
      console.error(errorMsg);
      return;
    }

    const resolvedFolderId = await this.resolveDestinationFolderId(destinationFolderId);
    if (!resolvedFolderId) {
      return;
    }

    new Notice("Google Drive sync started...");
    if (DEBUG_LOGGING) {
      console.log(subPath ? `Starting Google Drive sync for folder: ${subPath}...` : "Starting Google Drive sync...");
    }

    // 1. Get all local files (excluding hidden files/folders and filtered by subPath if provided)
    const localFiles = this.app.vault.getFiles().filter(file => {
      const pathParts = file.path.split('/');
      if (pathParts.some(part => part.startsWith('.'))) return false;
      if (subPath && file.path !== subPath && !file.path.startsWith(subPath + '/')) return false;
      return true;
    });
    const localFilePaths = new Set(localFiles.map(f => f.path));

    // 2. Fetch all remote files recursively from Google Drive (optionally scoped to the subPath folder)
    let remoteFiles = new Map<string, any>();
    if (subPath) {
      const pathParts = subPath.split('/').filter(Boolean);
      const subFolderId = await this.driveClient.resolveFolderHierarchy(pathParts, resolvedFolderId);
      remoteFiles = await this.getAllRemoteFiles(subFolderId, subPath);
    } else {
      remoteFiles = await this.getAllRemoteFiles(resolvedFolderId);
    }

    const remoteFilesByPath = new Map<string, any>();
    for (const [id, item] of remoteFiles.entries()) {
      remoteFilesByPath.set(item.computedPath, item);
    }

    await this.loadState();

    // 3. Resolve remote moves/renames (on Drive) first
    for (const [path, entry] of Object.entries(this.state.files)) {
      if (subPath && path !== subPath && !path.startsWith(subPath + '/')) continue;
      if (!entry.deleted && entry.driveFileId) {
        const rFile = remoteFiles.get(entry.driveFileId);
        if (rFile && rFile.computedPath !== path) {
          // File was moved/renamed on Google Drive!
          const localFile = this.app.vault.getAbstractFileByPath(path);
          if (localFile instanceof TFile) {
            const newPath = rFile.computedPath;
            if (DEBUG_LOGGING) {
              console.info(`Remote rename/move detected: renaming local file ${path} to ${newPath}`);
            }
            try {
              const pathParts = newPath.split('/');
              pathParts.pop();
              if (pathParts.length > 0) {
                await this.ensureLocalDirectory(pathParts.join('/'));
              }
              await this.app.vault.rename(localFile, newPath);
              
              // Update local state key
              delete this.state.files[path];
              this.state.files[newPath] = {
                ...entry,
                lastSyncTime: Date.now()
              };
              await this.saveState();
              
              localFilePaths.delete(path);
              localFilePaths.add(newPath);
              const lfIndex = localFiles.findIndex(f => f.path === path);
              if (lfIndex !== -1) {
                const lfFile = localFiles[lfIndex];
                if (lfFile) {
                  lfFile.path = newPath;
                }
              }
            } catch (err) {
              console.error(`Failed to apply remote rename/move from ${path} to ${newPath}:`, err);
            }
          }
        }
      }
    }

    // 4. Resolve local moves/renames (heuristic matching)
    const missingLocally = new Map<string, { path: string, entry: SyncEntry }[]>();
    for (const [path, entry] of Object.entries(this.state.files)) {
      if (subPath && path !== subPath && !path.startsWith(subPath + '/')) continue;
      if (!entry.deleted && !localFilePaths.has(path)) {
        const filename = path.split('/').pop() || '';
        if (filename) {
          if (!missingLocally.has(filename)) {
            missingLocally.set(filename, []);
          }
          missingLocally.get(filename)!.push({ path, entry });
        }
      }
    }

    const newLocally = new Map<string, TFile[]>();
    for (const file of localFiles) {
      const entry = this.state.files[file.path];
      if (!entry || entry.deleted) {
        const filename = file.name;
        if (!newLocally.has(filename)) {
          newLocally.set(filename, []);
        }
        newLocally.get(filename)!.push(file);
      }
    }

    const pairedNewFiles = new Set<string>();
    const pairedOldPaths = new Set<string>();

    for (const [filename, newFilesList] of newLocally.entries()) {
      const oldFilesList = missingLocally.get(filename);
      if (oldFilesList && oldFilesList.length > 0) {
        while (newFilesList.length > 0 && oldFilesList.length > 0) {
          const newFile = newFilesList.pop();
          const oldFile = oldFilesList.pop();
          if (newFile && oldFile) {
            pairedNewFiles.add(newFile.path);
            pairedOldPaths.add(oldFile.path);

            if (DEBUG_LOGGING) {
              console.info(`Heuristic match: renamed/moved file detected offline from ${oldFile.path} to ${newFile.path}`);
            }

            try {
              const driveFileId = oldFile.entry.driveFileId;
              const pathParts = newFile.path.split('/');
              const fileName = pathParts.pop() || newFile.name;
              const newParentFolderId = await this.driveClient.resolveFolderHierarchy(pathParts, resolvedFolderId);

              const parents = await this.driveClient.getFileParents(driveFileId);
              if (parents.length > 0) {
                const oldParentId = parents[0];
                if (oldParentId && oldParentId !== newParentFolderId) {
                  await this.driveClient.moveFile(driveFileId, oldParentId, newParentFolderId, fileName);
                } else if (filename !== fileName) {
                  await this.driveClient.renameItem(driveFileId, fileName);
                }
              } else {
                await this.syncFileCore(newFile, resolvedFolderId, oldFile.entry);
              }

              const { hash, content } = await this.getFileHash(newFile);
              if (oldFile.entry.hash !== hash) {
                await this.driveClient.updateFileContent(driveFileId, content);
              }

              delete this.state.files[oldFile.path];
              this.state.files[newFile.path] = {
                hash: hash,
                driveFileId: driveFileId,
                lastSyncTime: Date.now(),
                deleted: false,
              };
              await this.saveState();
              localFilePaths.delete(oldFile.path);
              localFilePaths.add(newFile.path);
            } catch (err) {
              console.error(`Heuristic rename sync failed from ${oldFile.path} to ${newFile.path}:`, err);
              pairedNewFiles.delete(newFile.path);
              pairedOldPaths.delete(oldFile.path);
            }
          }
        }
      }
    }

    // 5. Run the unified 2-way sync loop
    const allPaths = new Set<string>([
      ...localFiles.map(f => f.path),
      ...Object.keys(this.state.files).filter(path => !subPath || path === subPath || path.startsWith(subPath + '/')),
      ...Array.from(remoteFiles.values()).map(r => r.computedPath)
    ]);

    let uploadCount = 0;
    let downloadCount = 0;
    let conflictCount = 0;
    let skipCount = 0;
    let failCount = 0;
    let deleteCount = 0;

    let globalDeleteChoice: 'delete' | 'skip' | null = null;

    for (const path of allPaths) {
      const pathParts = path.split('/');
      if (pathParts.some(part => part.startsWith('.'))) continue;

      await this.withPathLock(path, async () => {
        const localFile = this.app.vault.getAbstractFileByPath(path);
        const remoteFile = remoteFilesByPath.get(path);
        const entry = this.state.files[path];

        const localExists = localFile instanceof TFile;
        const remoteExists = !!remoteFile;
        const stateExists = entry && !entry.deleted;
        const isBinary = this.isBinaryFile(path);

        try {
          // Case 1: Exists locally, remotely, and in state
          if (localExists && remoteExists && stateExists) {
            const { hash: localHash } = await this.getFileHash(localFile as TFile);
            const remoteHash = remoteFile.md5Checksum;
            const entryHash = entry.hash;

            if (localHash === entryHash && remoteHash === entryHash) {
              skipCount++;
            } else if (localHash !== entryHash && remoteHash === entryHash) {
              const driveFileId = await this.syncFileCore(localFile as TFile, resolvedFolderId, entry);
              entry.hash = localHash;
              entry.driveFileId = driveFileId;
              entry.lastSyncTime = Date.now();
              await this.saveState();
              uploadCount++;
            } else if (localHash === entryHash && remoteHash !== entryHash) {
              if (DEBUG_LOGGING) {
                console.log(`Case 1: Path ${path} modified remotely only. Downloading updated remote file.`);
              }
              const buffer = await this.driveClient.downloadFile(remoteFile.id);
              await this.writeLocalFile(path, buffer, isBinary);
              
              entry.hash = this.getHashFromContent(buffer, isBinary);
              entry.lastSyncTime = Date.now();
              await this.saveState();
              downloadCount++;
            } else {
              // Conflict (both modified since last sync)
              if (localHash === remoteHash) {
                entry.hash = localHash;
                entry.lastSyncTime = Date.now();
                await this.saveState();
                skipCount++;
              } else {
                conflictCount++;
                if (!isBinary) {
                  const localText = await this.app.vault.read(localFile as TFile);
                  const remoteBuffer = await this.driveClient.downloadFile(remoteFile.id);
                  const remoteText = new TextDecoder().decode(remoteBuffer);
                  const mergedText = this.mergeTextConflicts(localText, remoteText);
                  
                  await this.app.vault.modify(localFile as TFile, mergedText);
                  await this.driveClient.updateFileContent(remoteFile.id, mergedText);
                  
                  const mergedHash = CryptoJS.MD5(mergedText).toString();
                  entry.hash = mergedHash;
                  entry.lastSyncTime = Date.now();
                  await this.saveState();
                } else {
                  const conflictPath = this.getConflictPath(path);
                  
                  await this.ensureLocalDirectory(pathParts.slice(0, -1).join('/'));
                  await this.app.vault.rename(localFile as TFile, conflictPath);
                  
                  const remoteBuffer = await this.driveClient.downloadFile(remoteFile.id);
                  await this.writeLocalFile(path, remoteBuffer, true);
                  
                  const remoteHashCalculated = this.getHashFromContent(remoteBuffer, true);
                  entry.hash = remoteHashCalculated;
                  entry.lastSyncTime = Date.now();
                  
                  this.state.files[conflictPath] = {
                    hash: localHash,
                    driveFileId: '',
                    lastSyncTime: Date.now(),
                    deleted: false
                  };
                  await this.saveState();
                }
              }
            }
          }
          // Case 2: Exists locally and remotely, but NOT in active state (untracked conflict/union)
          else if (localExists && remoteExists && !stateExists) {
            const { hash: localHash } = await this.getFileHash(localFile as TFile);
            const remoteHash = remoteFile.md5Checksum;

            if (localHash === remoteHash) {
              this.state.files[path] = {
                hash: localHash,
                driveFileId: remoteFile.id,
                lastSyncTime: Date.now(),
                deleted: false
              };
              await this.saveState();
              skipCount++;
            } else {
              conflictCount++;
              if (!isBinary) {
                const localText = await this.app.vault.read(localFile as TFile);
                const remoteBuffer = await this.driveClient.downloadFile(remoteFile.id);
                const remoteText = new TextDecoder().decode(remoteBuffer);
                const mergedText = this.mergeTextConflicts(localText, remoteText);
                
                await this.app.vault.modify(localFile as TFile, mergedText);
                await this.driveClient.updateFileContent(remoteFile.id, mergedText);
                
                const mergedHash = CryptoJS.MD5(mergedText).toString();
                this.state.files[path] = {
                  hash: mergedHash,
                  driveFileId: remoteFile.id,
                  lastSyncTime: Date.now(),
                  deleted: false
                };
                await this.saveState();
              } else {
                const conflictPath = this.getConflictPath(path);
                
                await this.ensureLocalDirectory(pathParts.slice(0, -1).join('/'));
                await this.app.vault.rename(localFile as TFile, conflictPath);
                
                const remoteBuffer = await this.driveClient.downloadFile(remoteFile.id);
                await this.writeLocalFile(path, remoteBuffer, true);
                
                const remoteHashCalculated = this.getHashFromContent(remoteBuffer, true);
                this.state.files[path] = {
                  hash: remoteHashCalculated,
                  driveFileId: remoteFile.id,
                  lastSyncTime: Date.now(),
                  deleted: false
                };
                this.state.files[conflictPath] = {
                  hash: localHash,
                  driveFileId: '',
                  lastSyncTime: Date.now(),
                  deleted: false
                };
                await this.saveState();
              }
            }
          }
          // Case 3: Exists locally and in state, but NOT on Google Drive (Remote deletion)
          else if (localExists && stateExists && !remoteExists) {
            const { hash: localHash } = await this.getFileHash(localFile as TFile);
            const entryHash = entry.hash;

            if (localHash === entryHash) {
              await this.app.vault.delete(localFile as TFile);
              entry.deleted = true;
              entry.lastSyncTime = Date.now();
              await this.saveState();
              deleteCount++;
            } else {
              const driveFileId = await this.syncFileCore(localFile as TFile, resolvedFolderId, entry);
              entry.driveFileId = driveFileId;
              entry.hash = localHash;
              entry.lastSyncTime = Date.now();
              await this.saveState();
              uploadCount++;
            }
          }
          // Case 4: Exists remotely and in state, but NOT locally (Local deletion)
          else if (remoteExists && stateExists && !localExists) {
            const remoteHash = remoteFile.md5Checksum;
            const entryHash = entry.hash;

            if (remoteHash === entryHash) {
              let choice: 'delete' | 'skip' = 'skip';
              if (globalDeleteChoice) {
                choice = globalDeleteChoice;
              } else {
                const result = await this.askDeleteChoice(path);
                choice = result.choice;
                if (result.applyToAll) {
                  globalDeleteChoice = choice;
                }
              }

              if (choice === 'delete') {
                await this.driveClient.deleteItem(remoteFile.id);
              } else {
                entry.driveFileId = '';
              }
              entry.deleted = true;
              entry.lastSyncTime = Date.now();
              await this.saveState();
              deleteCount++;
            } else {
              const buffer = await this.driveClient.downloadFile(remoteFile.id);
              await this.writeLocalFile(path, buffer, isBinary);
              
              entry.hash = this.getHashFromContent(buffer, isBinary);
              entry.lastSyncTime = Date.now();
              await this.saveState();
              downloadCount++;
            }
          }
          // Case 5: New Local File (exists locally, absent remotely, absent in active state)
          else if (localExists && !remoteExists && !stateExists) {
            const { hash: localHash } = await this.getFileHash(localFile as TFile);
            const driveFileId = await this.syncFileCore(localFile as TFile, resolvedFolderId, entry);
            this.state.files[path] = {
              hash: localHash,
              driveFileId: driveFileId,
              lastSyncTime: Date.now(),
              deleted: false
            };
            await this.saveState();
            uploadCount++;
          }
          // Case 6: New Remote File (exists remotely, absent locally, absent in active state)
          else if (remoteExists && !localExists && !stateExists) {
            const buffer = await this.driveClient.downloadFile(remoteFile.id);
            await this.writeLocalFile(path, buffer, isBinary);

            const remoteHashCalculated = this.getHashFromContent(buffer, isBinary);
            this.state.files[path] = {
              hash: remoteHashCalculated,
              driveFileId: remoteFile.id,
              lastSyncTime: Date.now(),
              deleted: false
            };
            await this.saveState();
            downloadCount++;
          }
          // Case 7: Fully deleted (state exists but files absent everywhere)
          else if (stateExists && !localExists && !remoteExists) {
            entry.deleted = true;
            entry.lastSyncTime = Date.now();
            await this.saveState();
            deleteCount++;
          }
        } catch (err) {
          console.error(`Failed to 2-way sync path ${path}:`, err);
          failCount++;
        }
      });
    }

    const summary = subPath 
      ? `Sync complete for folder '${subPath}'! Uploaded: ${uploadCount}, Downloaded: ${downloadCount}, Conflicts merged: ${conflictCount}, Unchanged: ${skipCount}, Deletions processed: ${deleteCount}, Failed: ${failCount}`
      : `Sync complete! Uploaded: ${uploadCount}, Downloaded: ${downloadCount}, Conflicts merged: ${conflictCount}, Unchanged: ${skipCount}, Deletions processed: ${deleteCount}, Failed: ${failCount}`;
    if (DEBUG_LOGGING) {
      console.log(summary);
    }
    new Notice(summary);
  }
}
