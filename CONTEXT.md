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
