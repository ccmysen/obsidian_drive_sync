# Glossary of Terms

## Sync State
The local cache tracking sync metadata for all files in the vault. Stored in [sync_state.json](file:///home/bigharryox/development/obsidian_drive_sync/sync_state.json) (located in the plugin's configuration directory). It maps each file's path to its:
- **Hash**: SHA-256 hash of the file content.
- **Google Drive File ID**: The unique identifier of the corresponding file on Google Drive.
- **Last Sync Timestamp**: The epoch time when the file was last synced.
- **Deleted**: A boolean flag (`deleted: true`) indicating if the file has been deleted locally but is preserved on Google Drive (marked for future handling).

## Sync Operation
The sequence of steps executed on plugin load (`onload`):
1. Check if a `destinationFolderId` is configured in settings. If not, show a warning notice and skip the sync.
2. Load the existing **Sync State** from disk.
3. Scan all Markdown and asset files in the local Obsidian vault.
4. Compute the **Hash** of each local file.
5. Compare the local files against the **Sync State**:
   - For new/modified files: Recreate the directory hierarchy on Google Drive, upload the file, update the entry (setting `deleted: false`), and save the state.
   - For files present in the **Sync State** but missing locally: Mark the entry with `deleted: true` in the state, and save the state.
6. Save the final updated **Sync State** to disk.

## Google Drive Client
A browser-compatible REST client that communicates directly with the Google Drive v3 REST API using Obsidian's mobile-safe `requestUrl` utility. It uses `destinationFolderId` from settings as the root target for uploads, recursively resolves and creates directory hierarchies on Google Drive, handles authentication header injection, automatic access token refreshing (using the stored refresh token), file metadata queries, file creation, and file content updates.

---

# Development Learnings & Design Decisions

## 1. Directory Deletion & Empty Folder Pruning
- **Behavior**: Google Drive directory deletion is propagated locally by deleting the files inside the folder, leaving the empty directory structure.
- **Solution**: Implemented `pruneEmptyLocalFolders(rootPath?: string)` to recursively clean up empty directories.
- **Sorting**: Folders must be sorted by path depth in descending order (`split('/').length`) to ensure nested subdirectories are checked and pruned before their parent folders.
- **Dynamic Reference Safety**: In test mocks and potentially some runtime environments, folders returned by `getAllLoadedFiles()` can represent a snapshot state. When a child directory is deleted, the parent directory's cached `children` array is not updated dynamically in the snapshot. Resolving the folder dynamically inside the pruning loop using `getAbstractFileByPath` ensures the live child count is always evaluated correctly.
- **Ignored Directories**: Root (`""` or `"/"`) and dot-prefixed directories (e.g. `.obsidian`, `.git`) are explicitly ignored during pruning to protect plugin configuration and version control meta-folders.

## 2. Workspace Context Menu Events (`file-menu` vs `editor-menu`)
- **`file-menu`**: Triggered when right-clicking files or folders in the File Explorer. Context menu actions should be **selective** (e.g., syncing only the selected file or folder, or pruning empty folders starting from the selected path).
- **`editor-menu`**: Triggered when right-clicking inside the note editor. Context menu actions are **global** (e.g., running a full sync or pruning the entire vault) since there is no selected file explorer item.

## 3. Obsidian Icon Compatibility
- Obsidian packages its own subset of Lucide icons. Newer Lucide icon names (such as `'cloud-sync'`) may be missing or show up blank on some versions of Obsidian.
- Always prefer standard, backward-compatible Lucide icon names (like `'sync'` and `'folder-x'`) which are guaranteed to render correctly across all Obsidian clients.

## 4. Testing separation
- **Sync Logic Tests (`sync.test.ts`)**: Tests the synchronization matrices and vault observers by mocking `GoogleDriveClient` operations.
- **Client REST Tests (`google.test.ts`)**: Tests raw HTTP requests, OAuth token refresh cycles, API pagination, and folder creations by mocking the Obsidian `requestUrl` utility.
