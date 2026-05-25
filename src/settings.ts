import {App, PluginSettingTab, Setting} from 'obsidian';
import ObsidianDriveSync, {CLIENT_ID, REDIRECT_URI} from './main';

export interface ObsidianDriveSyncSettings {
  accessToken: string;
  refreshToken: string;
  destinationFolderId: string;
  destinationFolderName: string;
  manualAuth: boolean;
  codeVerifier: string;
  syncIntervalMinutes: number;
}

export const DEFAULT_SETTINGS: ObsidianDriveSyncSettings = {
  accessToken: '',
  refreshToken: '',
  destinationFolderId: '',
  destinationFolderName: '',
  manualAuth: false,
  codeVerifier: '',
  syncIntervalMinutes: 15,
};

export class ObsidianDriveSyncSettingTab extends PluginSettingTab {
  plugin: ObsidianDriveSync;

  constructor(app: App, plugin: ObsidianDriveSync) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const {containerEl} = this;

    containerEl.empty();



    containerEl.createEl('h2', {text: 'Synchronization Settings'});

    new Setting(containerEl)
      .setName('Destination Folder Name')
      .setDesc('The name of the Google Drive folder to sync to (use \'root\' to sync to the main Google Drive directory)')
      .addText(text =>
        text
          .setPlaceholder('Enter Folder Name')
          .setValue(this.plugin.settings.destinationFolderName)
          .onChange(async value => {
            this.plugin.settings.destinationFolderName = value;
            // Clear the resolved ID to force re-resolution during the next sync
            this.plugin.settings.destinationFolderId = '';
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Sync Interval (Minutes)')
      .setDesc('How often to run a full sync automatically. Set to 0 to disable periodic sync.')
      .addText(text =>
        text
          .setPlaceholder('15')
          .setValue(String(this.plugin.settings.syncIntervalMinutes))
          .onChange(async value => {
            const num = parseInt(value, 10);
            this.plugin.settings.syncIntervalMinutes = isNaN(num) ? 0 : num;
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl('h2', {text: 'Google Drive Authentication'});

    const isAuthorized =
      this.plugin.settings.accessToken && this.plugin.settings.refreshToken;

    new Setting(containerEl)
      .setName('Manual Authentication')
      .setDesc(
        'Enable this to copy the authorization code manually instead of using the automatic redirect.'
      )
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.manualAuth)
          .onChange(async value => {
            this.plugin.settings.manualAuth = value;
            await this.plugin.saveSettings();
            this.display(); // Refresh to show/hide code input
          })
      );

    new Setting(containerEl)
      .setName('Status')
      .setDesc(isAuthorized ? 'Authorized' : 'Not Authorized')
      .addButton(cb =>
        cb
          .setButtonText(isAuthorized ? 'Re-authenticate' : 'Login')
          .onClick(async () => {
            await this.plugin.handleLogin();
          })
      );

    if (this.plugin.settings.manualAuth && !isAuthorized) {
      let manualCode = '';
      new Setting(containerEl)
        .setName('Manual Authorization Code')
        .setDesc('Paste the code you copied from the browser here.')
        .addText(text =>
          text.setPlaceholder('Paste code here').onChange(value => (manualCode = value))
        )
        .addButton(cb =>
          cb.setButtonText('Submit Code').onClick(async () => {
            if (manualCode) {
              await this.plugin.exchangeCodeForTokens(manualCode);
              this.display();
            }
          })
        );
    }

    if (isAuthorized) {
      new Setting(containerEl)
        .setName('Logout')
        .setDesc('Clear authentication tokens')
        .addButton(cb =>
          cb
            .setButtonText('Logout')
            .onClick(async () => {
              this.plugin.settings.accessToken = '';
              this.plugin.settings.refreshToken = '';
              await this.plugin.saveSettings();
              this.display();
            })
        );
    }
  }
}
