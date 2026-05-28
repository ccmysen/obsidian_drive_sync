import { Plugin, TFile, TFolder, Notice, ObsidianProtocolData, requestUrl } from 'obsidian';
import { DEFAULT_SETTINGS, ObsidianDriveSyncSettings, ObsidianDriveSyncSettingTab } from './settings';
import * as CryptoJS from 'crypto-js';
import { GoogleDriveClient } from './google';
import { SyncManager } from './sync';

export const CLIENT_ID = '926375238404-crta4spf8usf5hvo174v1npitf5t10mq.apps.googleusercontent.com';
export const REDIRECT_URI = 'https://redirect.ccmysen.workers.dev/';

export default class ObsidianDriveSync extends Plugin {
  settings: ObsidianDriveSyncSettings;
  driveClient: GoogleDriveClient;
  syncManager: SyncManager;
  settingTab: ObsidianDriveSyncSettingTab;
  public lastSyncTime = Date.now();

  async onload() {
    await this.loadSettings();
    this.initDrive();

    // Register protocol handler for obsidian://obsidian_drive_sync?code=...
    this.registerObsidianProtocolHandler(
      'obsidian_drive_sync',
      async (data: ObsidianProtocolData) => {
        if (data.error) {
          const errorMsg = `Google Drive Auth Error: ${data.error}`;
          console.error(errorMsg);
          new Notice(errorMsg);
          return;
        }

        if (data.code) {
          await this.exchangeCodeForTokens(data.code);
        }
      }
    );

    // Register vault event listeners for incremental synchronization
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (file instanceof TFile && this.settings.accessToken && this.settings.refreshToken) {
          this.syncManager.debounceSyncFile(file, this.settings.destinationFolderId || this.settings.destinationFolderName);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on('create', (file) => {
        if (file instanceof TFile && this.settings.accessToken && this.settings.refreshToken) {
          this.syncManager.debounceSyncFile(file, this.settings.destinationFolderId || this.settings.destinationFolderName);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        if (this.settings.accessToken && this.settings.refreshToken) {
          this.syncManager.handleLocalDeletion(file.path);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (file instanceof TFile && this.settings.accessToken && this.settings.refreshToken) {
          this.syncManager.handleLocalRename(oldPath, file, this.settings.destinationFolderId || this.settings.destinationFolderName);
        }
      })
    );

    console.log("Obsidian Drive Sync: Registering context menu handlers...");

    this.registerEvent(
      this.app.workspace.on('editor-menu', (menu, editor, view) => {
        console.log("Obsidian Drive Sync: editor-menu event triggered.");
        menu.addItem((item) => {
          item
            .setTitle('Force Google Drive sync')
            .setIcon('sync')
            .onClick(async () => {
              console.log("Obsidian Drive Sync: 'Force Google Drive sync' clicked from editor-menu.");
              if (this.settings.accessToken && this.settings.refreshToken) {
                const folderId = this.settings.destinationFolderId || this.settings.destinationFolderName;
                await this.syncManager.runSync(folderId);
              } else {
                new Notice('Google Drive sync: Please authenticate in settings first.');
              }
            });
        });

        menu.addItem((item) => {
          item
            .setTitle('Prune empty local folders')
            .setIcon('folder-x')
            .onClick(async () => {
              console.log("Obsidian Drive Sync: 'Prune empty local folders' clicked from editor-menu.");
              const prunedCount = await this.syncManager.pruneEmptyLocalFolders();
              new Notice(`Pruned ${prunedCount} empty local folder(s).`);
            });
        });
      })
    );

    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        console.log("Obsidian Drive Sync: file-menu event triggered for path:", file.path);
        menu.addItem((item) => {
          item
            .setTitle('Force Google Drive sync')
            .setIcon('sync')
            .onClick(async () => {
              console.log(`Obsidian Drive Sync: 'Force Google Drive sync' clicked from file-menu for ${file.path}.`);
              if (this.settings.accessToken && this.settings.refreshToken) {
                const folderId = this.settings.destinationFolderId || this.settings.destinationFolderName;
                const resolvedFolderId = await this.syncManager.resolveDestinationFolderId(folderId);
                if (!resolvedFolderId) return;

                if (file instanceof TFile) {
                  new Notice(`Syncing file: ${file.name}`);
                  await this.syncManager.syncSingleFile(file, resolvedFolderId);
                  new Notice(`Syncing complete for: ${file.name}`);
                } else if (file instanceof TFolder) {
                  await this.syncManager.runSync(folderId, file.path);
                }
              } else {
                new Notice('Google Drive sync: Please authenticate in settings first.');
              }
            });
        });

        menu.addItem((item) => {
          item
            .setTitle('Prune empty local folders')
            .setIcon('folder-x')
            .onClick(async () => {
              console.log(`Obsidian Drive Sync: 'Prune empty local folders' clicked from file-menu for ${file.path}.`);
              const rootPath = file instanceof TFolder ? file.path : file.parent?.path;
              if (rootPath) {
                const prunedCount = await this.syncManager.pruneEmptyLocalFolders(rootPath);
                new Notice(`Pruned ${prunedCount} empty local folder(s) under ${rootPath}.`);
              } else {
                const prunedCount = await this.syncManager.pruneEmptyLocalFolders();
                new Notice(`Pruned ${prunedCount} empty local folder(s).`);
              }
            });
        });
      })
    );

    this.settingTab = new ObsidianDriveSyncSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);

    // Trigger sync asynchronously after loading so it doesn't block startup
    if (this.settings.accessToken && this.settings.refreshToken) {
      setTimeout(() => {
        this.syncManager.runSync(this.settings.destinationFolderId || this.settings.destinationFolderName)
          .catch(err => console.error("Onload sync failed", err));
      }, 2000);
    }

    // Start periodic sync check (runs every minute)
    this.registerInterval(
      window.setInterval(() => {
        const intervalMinutes = this.settings.syncIntervalMinutes;
        if (intervalMinutes > 0) {
          const elapsedMs = Date.now() - this.lastSyncTime;
          if (elapsedMs >= intervalMinutes * 60 * 1000) {
            if (this.settings.accessToken && this.settings.refreshToken && (this.settings.destinationFolderId || this.settings.destinationFolderName)) {
              if (DEBUG_LOGGING) {
                console.info("Periodic sync: starting scheduled full sync...");
              }
              this.syncManager.runSync(this.settings.destinationFolderId || this.settings.destinationFolderName)
                .catch(err => console.error("Periodic sync failed", err));
            }
          }
        }
      }, 60 * 1000)
    );
  }

  async exchangeCodeForTokens(code: string) {
    try {
      const redirectPath = this.settings.manualAuth ? 'display' : 'redirect';
      const dynamicRedirectUri = `https://redirect.ccmysen.workers.dev/${redirectPath}`;

      const response = await requestUrl({
        url: 'https://redirect.ccmysen.workers.dev/token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: code,
          client_id: CLIENT_ID,
          redirect_uri: dynamicRedirectUri,
          code_verifier: this.settings.codeVerifier,
        }).toString(),
      });

      const tokens = response.json;

      this.settings.accessToken = tokens.access_token || '';
      this.settings.refreshToken = tokens.refresh_token || '';
      // Clear verifier after use
      this.settings.codeVerifier = '';
      await this.saveSettings();

      // Re-initialize Drive and Sync Manager with the new tokens
      this.initDrive();

      new Notice('Google Drive authentication successful!');
      if (DEBUG_LOGGING) {
        console.debug('Token retrieved and saved via worker');
      }

      if (this.settingTab) {
        this.settingTab.display();
      }

      // Trigger an immediate sync after successful login
      this.syncManager.runSync(this.settings.destinationFolderId || this.settings.destinationFolderName)
        .catch(err => console.error("Immediate sync failed", err));
    } catch (e) {
      console.error('Failed to get tokens from code via worker', e);
      new Notice(
        'Failed to complete Google Drive authentication. Check console for details.'
      );
    }
  }

  generatePKCE() {
    // Generate a random string for the verifier
    const randomWords = CryptoJS.lib.WordArray.random(32);
    const verifier = CryptoJS.enc.Base64url.stringify(randomWords);

    // Create a SHA256 challenge from the verifier
    const hash = CryptoJS.SHA256(verifier);
    const challenge = CryptoJS.enc.Base64url.stringify(hash);

    return { verifier, challenge };
  }

  async handleLogin() {
    const redirectPath = this.settings.manualAuth ? 'display' : 'redirect';
    const dynamicRedirectUri = `https://redirect.ccmysen.workers.dev/${redirectPath}`;

    const { verifier, challenge } = this.generatePKCE();
    this.settings.codeVerifier = verifier;
    await this.saveSettings();

    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: dynamicRedirectUri,
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/drive.file',
      access_type: 'offline',
      prompt: 'consent',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: this.manifest.id,
    });

    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    window.open(authUrl);
  }

  initDrive() {
    this.driveClient = new GoogleDriveClient(
      CLIENT_ID,
      this.settings.accessToken,
      this.settings.refreshToken,
      async (accessToken, refreshToken) => {
        this.settings.accessToken = accessToken;
        this.settings.refreshToken = refreshToken;
        await this.saveSettings();
      }
    );
    this.syncManager = new SyncManager(this.app, this, this.driveClient);
  }

  async onunload() {
    if (DEBUG_LOGGING) {
      console.log('Un-load');
    }
  }

  async loadSettings() {
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      (await this.loadData()) as Partial<ObsidianDriveSyncSettings>
    );
    if (!this.settings.destinationFolderName) {
      this.settings.destinationFolderName = this.app.vault.getName();
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}
