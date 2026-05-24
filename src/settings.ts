import {App, PluginSettingTab, Setting} from 'obsidian';
import LoggingPlugin, {CLIENT_ID, REDIRECT_URI} from './main';

export interface LoggingPluginSettings {
  accessToken: string;
  refreshToken: string;
  destinationFolderId: string;
  manualAuth: boolean;
  codeVerifier: string;
}

export const DEFAULT_SETTINGS: LoggingPluginSettings = {
  accessToken: '',
  refreshToken: '',
  destinationFolderId: '',
  manualAuth: false,
  codeVerifier: '',
};

export class SampleSettingTab extends PluginSettingTab {
  plugin: LoggingPlugin;

  constructor(app: App, plugin: LoggingPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const {containerEl} = this;

    containerEl.empty();



    containerEl.createEl('h2', {text: 'Synchronization Settings'});

    new Setting(containerEl)
      .setName('Destination Folder ID')
      .setDesc('The ID of the Google Drive folder to sync to')
      .addText(text =>
        text
          .setPlaceholder('Enter Folder ID')
          .setValue(this.plugin.settings.destinationFolderId)
          .onChange(async value => {
            this.plugin.settings.destinationFolderId = value;
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
