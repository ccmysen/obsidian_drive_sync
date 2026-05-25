import { App, TFile, Notice, Plugin } from 'obsidian';
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

  // Recursively fetch all remote files under a root folder ID
  private async getAllRemoteFiles(rootFolderId: string): Promise<Map<string, any>> {
    const remoteFiles = new Map<string, any>();
    const queue = [rootFolderId];
    
    while (queue.length > 0) {
      const currentFolderId = queue.shift();
      if (!currentFolderId) continue;
      
      const items = await this.driveClient.listFilesInFolder(currentFolderId);
      for (const item of items) {
        if (item.mimeType === 'application/vnd.google-apps.folder') {
          queue.push(item.id);
        } else {
          remoteFiles.set(item.id, item);
        }
      }
    }
    return remoteFiles;
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
    const binaryExtensions = ['png', 'jpg', 'jpeg', 'gif', 'pdf', 'zip', 'mp3', 'mp4', 'mov', 'webp', 'svg'];
    const isBinary = binaryExtensions.includes(file.extension.toLowerCase());

    if (isBinary) {
      const buffer = await this.app.vault.readBinary(file);
      const wordArray = this.arrayBufferToWordArray(buffer);
      const hash = CryptoJS.MD5(wordArray).toString();
      return { hash, isBinary, content: buffer };
    } else {
      const text = await this.app.vault.read(file);
      const hash = CryptoJS.MD5(text).toString();
      return { hash, isBinary, content: text };
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

    await this.loadState();
    const entry = this.state.files[file.path];
    const { hash } = await this.getFileHash(file);

    // Skip if already synced and unchanged
    if (entry && entry.hash === hash && !entry.deleted) {
      return;
    }

    if (DEBUG_LOGGING) {
      if (!entry) {
        console.info(`Incremental sync: unseen file (new locally): ${file.path}`);
      } else if (entry.deleted) {
        console.info(`Incremental sync: restored file (previously marked as deleted): ${file.path}`);
      } else if (entry.hash !== hash) {
        console.info(`Incremental sync: modified file (hash mismatch): ${file.path}`);
      }
      console.log(`Incremental sync: syncing file: ${file.path}`);
    }

    const driveFileId = await this.syncFileCore(file, resolvedFolderId, entry);

    this.state.files[file.path] = {
      hash: hash,
      driveFileId: driveFileId,
      lastSyncTime: Date.now(),
      deleted: false,
    };

    await this.saveState();
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
      entry.deleted = true;
      entry.lastSyncTime = Date.now();
      await this.saveState();
    }
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

  // Run the full sync operation
  public async runSync(destinationFolderId: string): Promise<void> {
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
      console.log("Starting Google Drive sync...");
    }

    await this.loadState();

    const localFiles = this.app.vault.getFiles().filter(file => {
      const pathParts = file.path.split('/');
      return !pathParts.some(part => part.startsWith('.'));
    });
    const localFilePaths = new Set(localFiles.map(f => f.path));
    const excludedDotfilesCount = this.app.vault.getFiles().length - localFiles.length;

    let uploadCount = 0;
    let skipMd5MatchCount = 0;
    let failCount = 0;
    let localDeleteCount = 0;

    // A. Fetch all remote files recursively from Google Drive
    const remoteFiles = await this.getAllRemoteFiles(resolvedFolderId);

    // B. Check for remote deletions (active in state and present locally, but missing on server)
    // "propagate deletions locally (making sure that the file was not moved)"
    for (const [path, entry] of Object.entries(this.state.files)) {
      if (!entry.deleted && localFilePaths.has(path)) {
        if (entry.driveFileId && !remoteFiles.has(entry.driveFileId)) {
          // File was deleted on Google Drive!
          // Make sure it wasn't just moved by checking if the file ID exists anywhere on Drive
          const meta = await this.driveClient.getFileMetadata(entry.driveFileId);
          if (!meta || meta.trashed) {
            // Truly deleted on Drive! Propagate deletion locally.
            const localFile = this.app.vault.getAbstractFileByPath(path);
            if (localFile instanceof TFile) {
              if (DEBUG_LOGGING) {
                console.info(`Remote deletion detected: deleting local file ${path}`);
              }
              try {
                await this.app.vault.delete(localFile);
                localFilePaths.delete(path); // Remove from our set of active files
              } catch (delErr) {
                console.error(`Failed to delete local file ${path}:`, delErr);
              }
            }
            entry.deleted = true;
            entry.lastSyncTime = Date.now();
            await this.saveState();
            localDeleteCount++;
          }
        }
      }
    }

    // 1. Identify missing files (present in active state but not locally)
    const missingLocally = new Map<string, { path: string, entry: SyncEntry }[]>();
    for (const [path, entry] of Object.entries(this.state.files)) {
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

    // 2. Identify new files (locally present but not in active state)
    const newLocally = new Map<string, TFile[]>();
    const filesToUploadDirectly: TFile[] = [];

    for (const file of localFiles) {
      if (!localFilePaths.has(file.path)) continue; // Was deleted in remote deletion check
      const entry = this.state.files[file.path];
      if (!entry || entry.deleted) {
        const filename = file.name;
        if (!newLocally.has(filename)) {
          newLocally.set(filename, []);
        }
        newLocally.get(filename)!.push(file);
      } else {
        // Already tracked and not deleted - process normally (check for updates)
        filesToUploadDirectly.push(file);
      }
    }

    // 3. Match moved/renamed files using the filename heuristic
    const pairedNewFiles = new Set<string>();
    const pairedOldPaths = new Set<string>();

    for (const [filename, newFilesList] of newLocally.entries()) {
      const oldFilesList = missingLocally.get(filename);
      if (oldFilesList && oldFilesList.length > 0) {
        // Pair them up sequentially
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
              // Perform the move/reparenting logic on Google Drive
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
                // Fallback to uploading
                await this.syncFileCore(newFile, resolvedFolderId, oldFile.entry);
              }

              // Update content if hash changed
              const { hash, content } = await this.getFileHash(newFile);
              if (oldFile.entry.hash !== hash) {
                if (DEBUG_LOGGING) {
                  console.log(`Contents of heuristically matched file ${newFile.path} changed. Updating on Drive.`);
                }
                await this.driveClient.updateFileContent(driveFileId, content);
              }

              // Update state
              delete this.state.files[oldFile.path];
              this.state.files[newFile.path] = {
                hash: hash,
                driveFileId: driveFileId,
                lastSyncTime: Date.now(),
                deleted: false,
              };
              await this.saveState();
              uploadCount++;

            } catch (err) {
              console.error(`Heuristic rename sync failed from ${oldFile.path} to ${newFile.path}:`, err);
              // Fallback to treating them as independent delete + create
              pairedNewFiles.delete(newFile.path);
              pairedOldPaths.delete(oldFile.path);
            }
          }
        }
      }
    }

    // 4. Process remaining new files (unpaired)
    for (const [filename, newFilesList] of newLocally.entries()) {
      for (const file of newFilesList) {
        if (!pairedNewFiles.has(file.path)) {
          filesToUploadDirectly.push(file);
        }
      }
    }

    // 5. Normal Scan for files to upload or update
    for (const file of filesToUploadDirectly) {
      const entry = this.state.files[file.path];
      try {
        const { hash } = await this.getFileHash(file);

        // Check if file is already in sync
        if (entry && entry.hash === hash && !entry.deleted) {
          if (DEBUG_LOGGING) {
            console.debug(`Synced file (unchanged): ${file.path}`);
          }
          skipMd5MatchCount++;
          continue;
        }

        if (DEBUG_LOGGING) {
          if (!entry) {
            console.info(`Unseen file (new locally): ${file.path}`);
          } else if (entry.deleted) {
            console.info(`Restored file (previously marked as deleted): ${file.path}`);
          } else if (entry.hash !== hash) {
            console.info(`Modified file (hash mismatch): ${file.path}`);
          }
          console.log(`Syncing file: ${file.path}`);
        }

        const driveFileId = await this.syncFileCore(file, resolvedFolderId, entry);

        // Update local sync state
        this.state.files[file.path] = {
          hash: hash,
          driveFileId: driveFileId,
          lastSyncTime: Date.now(),
          deleted: false,
        };

        await this.saveState();
        uploadCount++;
      } catch (e) {
        console.error(`Failed to sync file ${file.path}:`, e);
        failCount++;
      }
    }

    // 6. Process remaining missing files (unpaired) and mark as deleted / prompt server delete
    let globalDeleteChoice: 'delete' | 'skip' | null = null;

    for (const [filename, oldFilesList] of missingLocally.entries()) {
      for (const oldFile of oldFilesList) {
        if (!pairedOldPaths.has(oldFile.path)) {
          const entry = this.state.files[oldFile.path];
          if (entry && !entry.deleted) {
            let choice: 'delete' | 'skip' = 'skip';

            // Check if the file still exists on Google Drive before prompting
            const fileStillOnDrive = entry.driveFileId && remoteFiles.has(entry.driveFileId);

            if (fileStillOnDrive) {
              if (globalDeleteChoice) {
                choice = globalDeleteChoice;
              } else {
                // Show confirmation modal to the user
                const result = await this.askDeleteChoice(oldFile.path);
                choice = result.choice;
                if (result.applyToAll) {
                  globalDeleteChoice = choice;
                }
              }

              if (choice === 'delete') {
                if (DEBUG_LOGGING) {
                  console.info(`Applying deletion on Google Drive for: ${oldFile.path}`);
                }
                try {
                  await this.driveClient.deleteItem(entry.driveFileId);
                } catch (e) {
                  console.error(`Failed to delete file ${oldFile.path} on Google Drive:`, e);
                }
              } else {
                if (DEBUG_LOGGING) {
                  console.info(`Skipping deletion on Google Drive for: ${oldFile.path} (leaving marked deleted in cache)`);
                }
                entry.driveFileId = ''; // Prevent future prompts
              }
            }

            entry.deleted = true;
            entry.lastSyncTime = Date.now();
            await this.saveState();
            localDeleteCount++;
          }
        }
      }
    }

    // 7. Check for local deletions that are marked deleted in cache, but still exist on the server (live deletions)
    for (const [path, entry] of Object.entries(this.state.files)) {
      if (entry.deleted && entry.driveFileId && remoteFiles.has(entry.driveFileId)) {
        let choice: 'delete' | 'skip' = 'skip';

        if (globalDeleteChoice) {
          choice = globalDeleteChoice;
        } else {
          // Show confirmation modal
          const result = await this.askDeleteChoice(path);
          choice = result.choice;
          if (result.applyToAll) {
            globalDeleteChoice = choice;
          }
        }

        if (choice === 'delete') {
          if (DEBUG_LOGGING) {
            console.info(`Applying deletion on Google Drive for: ${path}`);
          }
          try {
            await this.driveClient.deleteItem(entry.driveFileId);
          } catch (e) {
            console.error(`Failed to delete file ${path} on Google Drive:`, e);
          }
        } else {
          if (DEBUG_LOGGING) {
            console.info(`Skipping deletion on Google Drive for: ${path}`);
          }
          entry.driveFileId = ''; // Prevent future prompts
        }
        
        await this.saveState();
      }
    }

    const summary = `Sync complete! Synced: ${uploadCount}, Unchanged (MD5 match): ${skipMd5MatchCount}, Excluded (dotfiles): ${excludedDotfilesCount}, Deletions logged: ${localDeleteCount}, Failed: ${failCount}`;
    if (DEBUG_LOGGING) {
      console.log(summary);
    }
    new Notice(summary);
  }
}
