import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GoogleDriveClient } from '../google';
import { requestUrl } from 'obsidian';

// Mock the compile-time constant
(globalThis as any).DEBUG_LOGGING = false;

vi.mock('obsidian', () => {
  return {
    requestUrl: vi.fn(),
  };
});

describe('GoogleDriveClient', () => {
  let client: GoogleDriveClient;
  let onTokenRefreshMock: any;

  beforeEach(() => {
    vi.clearAllMocks();
    onTokenRefreshMock = vi.fn().mockResolvedValue(undefined);
    client = new GoogleDriveClient(
      'my-client-id',
      'initial-access-token',
      'initial-refresh-token',
      onTokenRefreshMock
    );
  });

  it('should inject Authorization header into requests', async () => {
    vi.mocked(requestUrl).mockResolvedValue({
      status: 200,
      headers: {},
      text: '{}',
      json: { id: 'file123' },
      arrayBuffer: new ArrayBuffer(0),
    });

    const meta = await client.getFileMetadata('file123');

    expect(requestUrl).toHaveBeenCalledTimes(1);
    const lastCallParam = vi.mocked(requestUrl).mock.calls[0]?.[0];
    expect(lastCallParam?.headers?.['Authorization']).toBe('Bearer initial-access-token');
    expect(meta?.id).toBe('file123');
  });

  it('should refresh access token on 401 status and retry the request', async () => {
    // 1. First request fails with 401
    // 2. Token refresh request succeeds with status 200
    // 3. Retried request succeeds with status 200
    vi.mocked(requestUrl)
      .mockResolvedValueOnce({
        status: 401,
        headers: {},
        text: 'Unauthorized',
        json: null,
        arrayBuffer: new ArrayBuffer(0),
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        text: '{"access_token": "new-access-token", "refresh_token": "new-refresh-token"}',
        json: { access_token: 'new-access-token', refresh_token: 'new-refresh-token' },
        arrayBuffer: new ArrayBuffer(0),
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        text: '{"id": "file123"}',
        json: { id: 'file123' },
        arrayBuffer: new ArrayBuffer(0),
      });

    const meta = await client.getFileMetadata('file123');

    // Verify it called requestUrl three times
    expect(requestUrl).toHaveBeenCalledTimes(3);

    // Verify refresh endpoint request params
    const refreshCallParam = vi.mocked(requestUrl).mock.calls[1]?.[0];
    expect(refreshCallParam?.url).toBe('https://redirect.ccmysen.workers.dev/token');
    expect(refreshCallParam?.method).toBe('POST');
    expect(refreshCallParam?.body).toContain('refresh_token=initial-refresh-token');

    // Verify tokens on client instance are updated
    expect(client['accessToken']).toBe('new-access-token');
    expect(client['refreshToken']).toBe('new-refresh-token');

    // Verify save callback was executed
    expect(onTokenRefreshMock).toHaveBeenCalledWith('new-access-token', 'new-refresh-token');

    // Verify retry parameter was called with new token
    const retryCallParam = vi.mocked(requestUrl).mock.calls[2]?.[0];
    expect(retryCallParam?.headers?.['Authorization']).toBe('Bearer new-access-token');
    expect(meta?.id).toBe('file123');
  });

  it('should propagate errors for non-404 API failures', async () => {
    vi.mocked(requestUrl).mockResolvedValue({
      status: 500,
      headers: {},
      text: 'Internal Server Error',
      json: null,
      arrayBuffer: new ArrayBuffer(0),
    });

    await expect(client.getFileMetadata('file123')).rejects.toThrow(
      'Google API request failed with status 500'
    );
  });

  it('should return null on 404 API failures from getFileMetadata', async () => {
    vi.mocked(requestUrl).mockResolvedValue({
      status: 404,
      headers: {},
      text: 'File not found',
      json: null,
      arrayBuffer: new ArrayBuffer(0),
    });

    const meta = await client.getFileMetadata('file123');
    expect(meta).toBeNull();
  });

  it('should fetch paginated list of files using nextPageToken', async () => {
    // Page 1 returns nextPageToken and 1 file
    // Page 2 returns no nextPageToken and 1 file
    vi.mocked(requestUrl)
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        text: '',
        json: { files: [{ id: 'f1', name: 'n1' }], nextPageToken: 'token-page-2' },
        arrayBuffer: new ArrayBuffer(0),
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        text: '',
        json: { files: [{ id: 'f2', name: 'n2' }] },
        arrayBuffer: new ArrayBuffer(0),
      });

    const files = await client.listFilesInFolder('parentFolderId');

    expect(requestUrl).toHaveBeenCalledTimes(2);
    expect(files.length).toBe(2);
    expect(files[0]?.id).toBe('f1');
    expect(files[1]?.id).toBe('f2');

    const firstCallUrl = vi.mocked(requestUrl).mock.calls[0]?.[0]?.url;
    const secondCallUrl = vi.mocked(requestUrl).mock.calls[1]?.[0]?.url;

    expect(firstCallUrl).not.toContain('pageToken');
    expect(secondCallUrl).toContain('pageToken=token-page-2');
  });

  it('should recursively resolve folder hierarchy, finding existing and creating missing folders', async () => {
    // We try to resolve "FolderA/FolderB".
    // 1. Search for FolderA: returns null.
    // 2. Create FolderA: returns id "folderA_id".
    // 3. Search for FolderB under folderA_id: returns existing folder with id "folderB_id".
    vi.mocked(requestUrl)
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        text: '',
        json: { files: [] }, // FolderA doesn't exist
        arrayBuffer: new ArrayBuffer(0),
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        text: '',
        json: { id: 'folderA_id' }, // Created FolderA
        arrayBuffer: new ArrayBuffer(0),
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        text: '',
        json: { files: [{ id: 'folderB_id', name: 'FolderB', mimeType: 'application/vnd.google-apps.folder' }] }, // FolderB exists
        arrayBuffer: new ArrayBuffer(0),
      });

    const finalFolderId = await client.resolveFolderHierarchy(['FolderA', 'FolderB'], 'rootId');

    expect(requestUrl).toHaveBeenCalledTimes(3);
    expect(finalFolderId).toBe('folderB_id');

    // 1. Search call for FolderA
    const searchCall1 = vi.mocked(requestUrl).mock.calls[0]?.[0];
    expect(searchCall1?.url).toContain("'rootId'%20in%20parents");
    expect(searchCall1?.url).toContain("name%20%3D%20'FolderA'");

    // 2. Create call for FolderA
    const createCall1 = vi.mocked(requestUrl).mock.calls[1]?.[0];
    expect(JSON.parse(createCall1?.body as string)).toEqual({
      name: 'FolderA',
      mimeType: 'application/vnd.google-apps.folder',
      parents: ['rootId']
    });

    // 3. Search call for FolderB
    const searchCall2 = vi.mocked(requestUrl).mock.calls[2]?.[0];
    expect(searchCall2?.url).toContain("'folderA_id'%20in%20parents");
    expect(searchCall2?.url).toContain("name%20%3D%20'FolderB'");
  });
});
