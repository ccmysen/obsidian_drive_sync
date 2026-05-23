import { requestUrl, RequestUrlParam, RequestUrlResponse } from 'obsidian';

export class GoogleDriveClient {
  private clientId: string;
  private clientSecret: string;
  private accessToken: string;
  private refreshToken: string;
  private onTokenRefresh: (accessToken: string, refreshToken: string) => Promise<void>;

  constructor(
    clientId: string,
    clientSecret: string,
    accessToken: string,
    refreshToken: string,
    onTokenRefresh: (accessToken: string, refreshToken: string) => Promise<void>
  ) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
    this.onTokenRefresh = onTokenRefresh;
  }

  // Wrapper for requestUrl with auto-refresh on 401
  private async request(param: RequestUrlParam, isRetry = false): Promise<RequestUrlResponse> {
    if (!this.accessToken) {
      throw new Error("No access token available. Please authenticate first.");
    }

    // Set authorization header
    if (!param.headers) {
      param.headers = {};
    }
    param.headers['Authorization'] = `Bearer ${this.accessToken}`;
    param.throw = false; // Inspect status manually

    const res = await requestUrl(param);

    if (res.status === 401 && !isRetry) {
      console.log("Access token expired (401). Attempting token refresh...");
      await this.refreshAccessToken();
      // Update authorization header with new token
      if (param.headers) {
        param.headers['Authorization'] = `Bearer ${this.accessToken}`;
      }
      // Retry with the new access token
      return this.request(param, true);
    }

    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Google API request failed with status ${res.status}: ${res.text}`);
    }

    return res;
  }

  private async refreshAccessToken(): Promise<void> {
    if (!this.refreshToken) {
      throw new Error("No refresh token available. Cannot refresh access token.");
    }

    console.log("Refreshing Google Drive API access token...");
    const res = await requestUrl({
      url: 'https://oauth2.googleapis.com/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: this.refreshToken,
      }).toString(),
      throw: false,
    });

    if (res.status !== 200) {
      throw new Error(`Failed to refresh access token: ${res.text}`);
    }

    const data = res.json;
    if (data.access_token) {
      this.accessToken = data.access_token;
      // If a new refresh token is returned, update it too
      if (data.refresh_token) {
        this.refreshToken = data.refresh_token;
      }
      // Save updated tokens
      await this.onTokenRefresh(this.accessToken, this.refreshToken);
      console.log("Access token successfully refreshed and saved.");
    } else {
      throw new Error("No access token returned in refresh response.");
    }
  }

  // Find a file/folder by name and parent folder ID
  public async findItem(name: string, parentId: string, isFolder = false): Promise<any | null> {
    const mimeQuery = isFolder ? "and mimeType = 'application/vnd.google-apps.folder'" : "and mimeType != 'application/vnd.google-apps.folder'";
    const q = `'${parentId}' in parents and name = '${name.replace(/'/g, "\\'")}' ${mimeQuery} and trashed = false`;
    
    const res = await this.request({
      url: `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,md5Checksum)`,
      method: 'GET',
    });

    const files = res.json.files || [];
    return files.length > 0 ? files[0] : null;
  }

  // Create a folder under a parent folder
  public async createFolder(name: string, parentId: string): Promise<string> {
    const res = await this.request({
      url: 'https://www.googleapis.com/drive/v3/files',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentId],
      }),
    });

    return res.json.id;
  }

  // Recreate local folder path hierarchically on Google Drive under rootFolderId
  // For path "Folder1/Folder2", resolves Folder1 inside rootFolderId, then Folder2 inside Folder1.
  // Returns the leaf folder ID.
  public async resolveFolderHierarchy(pathParts: string[], rootFolderId: string): Promise<string> {
    let currentParentId = rootFolderId;
    for (const part of pathParts) {
      if (!part) continue;
      const existingFolder = await this.findItem(part, currentParentId, true);
      if (existingFolder) {
        currentParentId = existingFolder.id;
      } else {
        currentParentId = await this.createFolder(part, currentParentId);
      }
    }
    return currentParentId;
  }

  // Create a new file (2-step upload)
  public async createFile(name: string, parentId: string, content: string | ArrayBuffer): Promise<string> {
    // 1. Create file metadata
    const metadataRes = await this.request({
      url: 'https://www.googleapis.com/drive/v3/files',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: name,
        parents: [parentId],
      }),
    });

    const fileId = metadataRes.json.id;

    // 2. Upload file content
    await this.updateFileContent(fileId, content);

    return fileId;
  }

  // Update file content
  public async updateFileContent(fileId: string, content: string | ArrayBuffer): Promise<void> {
    await this.request({
      url: `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/octet-stream',
      },
      body: content,
    });
  }
}
