# Obsidian Sample Plugin

This is a sample plugin for Obsidian (https://obsidian.md).

This project uses TypeScript to provide type checking and documentation.
The repo depends on the latest plugin API (obsidian.d.ts) in TypeScript Definition format, which contains TSDoc comments describing what it does.

This sample plugin demonstrates some of the basic functionality the plugin API can do.
- Adds a ribbon icon, which shows a Notice when clicked.
- Adds a command "Open modal (simple)" which opens a Modal.
- Adds a plugin setting tab to the settings page.
- Registers a global click event and output 'click' to the console.
- Registers a global interval which logs 'setInterval' to the console.

## First time developing plugins?

Quick starting guide for new plugin devs:

- Check if [someone already developed a plugin for what you want](https://obsidian.md/plugins)! There might be an existing plugin similar enough that you can partner up with.
- Make a copy of this repo as a template with the "Use this template" button (login to GitHub if you don't see it).
- Clone your repo to a local development folder. For convenience, you can place this folder in your `.obsidian/plugins/your-plugin-name` folder.
- Install NodeJS, then run `npm i` in the command line under your repo folder.
- Run `npm run dev` to compile your plugin from `main.ts` to `main.js`.
- Make changes to `main.ts` (or create new `.ts` files). Those changes should be automatically compiled into `main.js`.
- Reload Obsidian to load the new version of your plugin.
- Enable plugin in settings window.
- For updates to the Obsidian API run `npm update` in the command line under your repo folder.

## Releasing new releases

- Update your `manifest.json` with your new version number, such as `1.0.1`, and the minimum Obsidian version required for your latest release.
- Update your `versions.json` file with `"new-plugin-version": "minimum-obsidian-version"` so older versions of Obsidian can download an older version of your plugin that's compatible.
- Create new GitHub release using your new version number as the "Tag version". Use the exact version number, don't include a prefix `v`. See here for an example: https://github.com/obsidianmd/obsidian-sample-plugin/releases
- Upload the files `manifest.json`, `main.js`, `styles.css` as binary attachments. Note: The manifest.json file must be in two places, first the root path of your repository and also in the release.
- Publish the release.

> You can simplify the version bump process by running `npm version patch`, `npm version minor` or `npm version major` after updating `minAppVersion` manually in `manifest.json`.
> The command will bump version in `manifest.json` and `package.json`, and add the entry for the new version to `versions.json`

## Adding your plugin to the community plugin list

- Check the [plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines).
- Publish an initial version.
- Make sure you have a `README.md` file in the root of your repo.
- Make a pull request at https://github.com/obsidianmd/obsidian-releases to add your plugin.

## How to use

- Clone this repo.
- Make sure your NodeJS is at least v16 (`node --version`).
- `npm i` or `yarn` to install dependencies.
- `npm run dev` to start compilation in watch mode.

## Manually installing the plugin

- Copy over `main.js`, `styles.css`, `manifest.json` to your vault `VaultFolder/.obsidian/plugins/your-plugin-id/`.

## Testing
This project uses **Vitest** for running unit tests on the sync engine in a mocked environment.

To run the unit tests:
```bash
npm run test
```

The comprehensive testing strategy, covering both manual testing inside a real Obsidian test vault and automated unit tests with mocks, is documented in the test plan:
- [test_plan.md](file:///home/bigharryox/.gemini/antigravity-cli/brain/20d8c6f8-8723-4d13-8a65-23e719960566/test_plan.md)

## Sync Implementation & Architecture

This plugin implements a lightweight, mobile-safe synchronization mechanism that automatically pushes local vault changes to a specified Google Drive destination folder on plugin load (`onload`).

### 1. State Tracking (`sync_state.json`)
The sync state is cached locally in `.obsidian/plugins/<plugin-id>/sync_state.json` (or the corresponding plugin directory) to prevent unnecessary uploads:
- **Hashing**: Computes MD5 hashes of all local files (using string hashing for text/markdown files and binary word-array conversion for assets).
- **Metadata**: Each entry maps a file path to its `hash`, its remote `driveFileId`, a `lastSyncTime` timestamp, and a `deleted` status flag.
- **Incremental Saves**: The state file is updated and saved to disk immediately after each file successfully syncs, protecting against data loss if the sync operation is interrupted.

### 2. Folder Hierarchy resolution
Google Drive doesn't use path strings to organize files; it uses unique folder IDs with parent-child relationships. The sync engine resolves paths by:
- Scanning the local path parts (e.g., `Documents/Notes/my-note.md`).
- Checking and dynamically creating folders on Drive (`Documents` inside the root destination folder, then `Notes` inside `Documents`).
- Caching resolved folder IDs in-memory during execution to minimize redundant API calls.

### 3. Current Limitations (Roadmap / Future Tasks)
The current version is a **v1 implementation** and has the following design boundaries:
- **One-Way Sync (Upload-Only)**: Files only flow from the local vault to Google Drive. Remote additions or edits on Google Drive are not pulled down to Obsidian.
- **No Remote Deletion**: Local deletions are marked as `deleted: true` in `sync_state.json` but the corresponding file is **not** deleted or trashed on Google Drive (designed to prevent accidental data loss).
- **Conflict Resolution**: Since changes only flow from local to remote, there is no conflict resolution logic for concurrent edits on both sides.
- **Size Limits**: For massive vaults with large binary assets, the in-memory array-buffer hashing conversion may experience performance degradation.

## Improve code quality with eslint
- [ESLint](https://eslint.org/) is a tool that analyzes your code to quickly find problems. You can run ESLint against your plugin to find common bugs and ways to improve your code. 
- This project already has eslint preconfigured, you can invoke a check by running`npm run lint`
- Together with a custom eslint [plugin](https://github.com/obsidianmd/eslint-plugin) for Obsidan specific code guidelines.
- A GitHub action is preconfigured to automatically lint every commit on all branches.

## Funding URL

You can include funding URLs where people who use your plugin can financially support it.

The simple way is to set the `fundingUrl` field to your link in your `manifest.json` file:

```json
{
    "fundingUrl": "https://buymeacoffee.com"
}
```

If you have multiple URLs, you can also do:

```json
{
    "fundingUrl": {
        "Buy Me a Coffee": "https://buymeacoffee.com",
        "GitHub Sponsor": "https://github.com/sponsors",
        "Patreon": "https://www.patreon.com/"
    }
}
```

## API Documentation

See https://docs.obsidian.md
