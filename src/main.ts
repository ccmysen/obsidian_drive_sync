import { Plugin, TFile, Notice, ObsidianProtocolData, requestUrl } from 'obsidian';
import { DEFAULT_SETTINGS, LoggingPluginSettings, SampleSettingTab } from './settings';
import * as CryptoJS from 'crypto-js';
import { GoogleDriveClient } from './google';
import { SyncManager } from './sync';

export const CLIENT_ID = '926375238404-crta4spf8usf5hvo174v1npitf5t10mq.apps.googleusercontent.com';
export const CLIENT_SECRET = 'YOUR_CLIENT_SECRET_HERE';
export const REDIRECT_URI = 'https://redirect.ccmysen.workers.dev/';

export default class LoggingPlugin extends Plugin {
  settings: LoggingPluginSettings;
  driveClient: GoogleDriveClient;
  syncManager: SyncManager;

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

    console.debug('On-load');
    this.registerEvent(
      this.app.metadataCache.on('changed', (file: TFile) => {
        console.debug(`a file ${file.name} has changed size ${file.stat.size}`);
      })
    );

    this.addSettingTab(new SampleSettingTab(this.app, this));

    // Trigger sync asynchronously after loading so it doesn't block startup
    if (this.settings.accessToken && this.settings.refreshToken) {
      setTimeout(() => {
        this.syncManager.runSync(this.settings.destinationFolderId)
          .catch(err => console.error("Onload sync failed", err));
      }, 2000);
    }
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
      console.debug('Token retrieved and saved via worker');

      // Trigger an immediate sync after successful login
      this.syncManager.runSync(this.settings.destinationFolderId)
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
      scope: 'https://www.googleapis.com/auth/drive',
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
      CLIENT_SECRET,
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
    console.log('Un-load');
  }

  async loadSettings() {
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      (await this.loadData()) as Partial<LoggingPluginSettings>
    );
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}
