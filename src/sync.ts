import { App, TFile, Notice, Plugin } from 'obsidian';
import * as CryptoJS from 'crypto-js';
import { GoogleDriveClient } from './google';

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

  constructor(app: App, plugin: Plugin, driveClient: GoogleDriveClient) {
    this.app = app;
    this.plugin = plugin;
    this.driveClient = driveClient;
    this.stateFilePath = `${this.app.vault.configDir}/plugins/${this.plugin.manifest.id}/sync_state.json`;
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

  // Run the full sync operation
  public async runSync(destinationFolderId: string): Promise<void> {
    if (!destinationFolderId) {
      new Notice("Google Drive destination folder ID is not configured. Skipping sync.");
      return;
    }

    new Notice("Google Drive sync started...");
    console.log("Starting Google Drive sync...");

    await this.loadState();

    const localFiles = this.app.vault.getFiles();
    const localFilePaths = new Set<string>();

    let uploadCount = 0;
    let skipCount = 0;
    let failCount = 0;

    // 1. Scan and upload/update local files
    for (const file of localFiles) {
      // Exclude hidden files or folders (e.g. .obsidian config files)
      if (file.path.startsWith('.')) continue;

      localFilePaths.add(file.path);
      const entry = this.state.files[file.path];

      try {
        const { hash, content } = await this.getFileHash(file);

        if (!entry) {
          console.info(`Unseen file (new locally): ${file.path}`);
        } else if (entry.deleted) {
          console.info(`Restored file (previously marked as deleted): ${file.path}`);
        } else if (entry.hash !== hash) {
          console.info(`Modified file (hash mismatch): ${file.path}`);
        }

        // Check if file is already in sync
        if (entry && entry.hash === hash && !entry.deleted) {
          console.debug(`Synced file (unchanged): ${file.path}`);
          skipCount++;
          continue;
        }

        console.log(`Syncing file: ${file.path}`);
        
        // Resolve parent folder hierarchy
        const pathParts = file.path.split('/');
        const fileName = pathParts.pop() || file.name;
        
        // Resolve folder hierarchy on Drive
        const parentFolderId = await this.driveClient.resolveFolderHierarchy(pathParts, destinationFolderId);

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
          console.log(`Updated file content on Drive: ${file.path}`);
        } else {
          // Create new file on Drive
          driveFileId = await this.driveClient.createFile(fileName, parentFolderId, content);
          console.log(`Created new file on Drive: ${file.path}`);
        }

        // Update local sync state
        this.state.files[file.path] = {
          hash: hash,
          driveFileId: driveFileId,
          lastSyncTime: Date.now(),
          deleted: false,
        };

        // Incremental save
        await this.saveState();
        uploadCount++;
      } catch (e) {
        console.error(`Failed to sync file ${file.path}:`, e);
        failCount++;
      }
    }

    // 2. Scan for deleted files (exist in state but not locally)
    let deleteMarkCount = 0;
    for (const path of Object.keys(this.state.files)) {
      if (!localFilePaths.has(path)) {
        const entry = this.state.files[path];
        if (entry && !entry.deleted) {
          console.info(`Deleted file (exists in state but missing locally): ${path}`);
          entry.deleted = true;
          entry.lastSyncTime = Date.now();
          await this.saveState(); // Incremental save
          deleteMarkCount++;
        }
      }
    }

    const summary = `Sync complete! Synced: ${uploadCount}, Skipped: ${skipCount}, Deletions logged: ${deleteMarkCount}, Failed: ${failCount}`;
    console.log(summary);
    new Notice(summary);
  }
}
