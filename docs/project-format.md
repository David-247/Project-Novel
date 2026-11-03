# Novel project format

A Novel project is an ordinary folder. Everything in it is readable without Novel: two JSON files and one SQLite
database. The folder name becomes the project title when the project is created.

```
My Novel/
├── project.json      metadata and schema version
├── manuscript.json   the manuscript as ProseMirror document JSON
├── index.sqlite      index (revisions); can be rebuilt, never the only copy of text
└── .recovery/        crash-recovery data
    ├── manuscript.json                 current snapshot (only while there are unsaved changes)
    └── unrestored-<savedAt>.json       older snapshots set aside, never deleted by Novel
```

Projects contain no tokens, credentials, account data or absolute paths of other machines. Novel never makes
network calls.

## project.json

Pretty-printed UTF-8 JSON.

| Field           | Type    | Notes                                                            |
| --------------- | ------- | ---------------------------------------------------------------- |
| `format`        | string  | Always `"novel-project"`. Identifies the folder as a project.     |
| `schemaVersion` | integer | Format version. Current: `1`.                                    |
| `id`            | string  | Random UUID, assigned at creation, never changes.                 |
| `title`         | string  | Project title.                                                   |
| `createdAt`     | string  | ISO 8601 timestamp (UTC).                                        |
| `updatedAt`     | string  | ISO 8601 timestamp (UTC) of the last save.                        |

```json
{
  "format": "novel-project",
  "schemaVersion": 1,
  "id": "6f1c1f0e-4f4e-4c55-9d43-2d6f1e0f3a10",
  "title": "My Novel",
  "createdAt": "2026-11-03T09:00:00.000Z",
  "updatedAt": "2026-11-03T10:15:42.120Z"
}
```

**Versioning.** A file with a `schemaVersion` higher than the app supports is refused with "saved by a newer version
of Novel" rather than being opened and possibly damaged. Older versions will be migrated on open when version 2
exists. Unknown extra fields are ignored.

## manuscript.json

The whole manuscript as a single ProseMirror document in JSON form (`editor.state.doc.toJSON()`), written compactly
(no indentation). The root node has `"type": "doc"`; nodes have `type` and optional `attrs`, `content`, `marks` and
`text`.

```json
{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"It was a dark and stormy night."}]}]}
```

On open, the file must be valid JSON with this shape; otherwise Novel shows an error dialog ("manuscript.json is
damaged...") and does not open the project. The editor applies its own schema on load.

## index.sqlite

SQLite database opened through the Tauri SQL plugin and accessed with Drizzle ORM (`drizzle-orm/sqlite-proxy`). Its
schema version is stored in `PRAGMA user_version` (current: `1`). If the file is missing it is created; if it is
unreadable or from a newer version the project still opens, without the index. Schema source:
`src/features/storage/schema.ts`.

### `revisions` (version 1)

One row per save.

| Column       | Type    | Notes                                                          |
| ------------ | ------- | -------------------------------------------------------------- |
| `id`         | INTEGER | Primary key, autoincrement.                                    |
| `created_at` | TEXT    | ISO 8601 timestamp.                                            |
| `kind`       | TEXT    | `'manual'` (user save) or `'autosave'`.                        |
| `byte_size`  | INTEGER | UTF-8 size of the saved manuscript.json.                       |
| `path`       | TEXT    | Project-relative file that was saved (`manuscript.json`), or NULL. |
| `content`    | TEXT    | Inline snapshot, reserved; NULL in Phase 1.                    |

A `comments` table is planned for a later schema version.

## Saving

Every file is written atomically by the Rust command `storage_write_file_atomic`: the new contents go to a temp file
with a random name (`.<name>.XXXXXX.tmp`, created exclusively so an existing file or symlink is never followed) in
the same folder, the temp file is fsynced, then renamed over the original. A crash leaves either the old or the new
file, never a partial one. A leftover `*.tmp` file is safe to delete.

Safety rules enforced in Rust:

- Reads and writes are confined to the open project folder. Paths are canonicalized, so `..` and symlinks cannot
  escape it. A project file that is itself a symbolic link is never overwritten.
- Only Rust sets that folder. It comes either from the native folder dialog, which Rust shows itself
  (`storage_pick_project_folder`), or from an entry in the recent list (`storage_open_recent_root`). The webview can
  only undo the last change (`storage_restore_project_root`, used after a failed open) or clear the folder
  (`storage_clear_project_root`). It cannot name an arbitrary folder.
- Existence checks (`storage_path_exists`) only answer for paths inside the open project folder or a folder in the
  recent list, and refuse `..`.
- New Project refuses a folder that already holds `manuscript.json` or `index.sqlite` without a `project.json`, so
  leftovers of an earlier project are never overwritten.
- The final rename is retried for about 0.4 s when another program (antivirus, OneDrive, Dropbox) briefly locks the
  target.
- **Known limitation:** `index.sqlite` is opened through the Tauri SQL plugin, which has no path scope. The webview
  could open a SQLite file anywhere. Only the JSON files go through the confined commands.

Save order: `manuscript.json`, then `project.json` (`updatedAt`), then a `revisions` row. After a save that leaves
the document clean, `.recovery/manuscript.json` is deleted.

All writes to a project (saves, autosave snapshots, recovery cleanup) go through one queue in the frontend, so they
never overlap.

Errors from Rust carry a `kind`: `not_found`, `invalid_path`, `outside_project`, `not_recent`, `symlink`,
`disk_full` (ENOSPC/EDQUOT, Windows `ERROR_DISK_FULL`/`ERROR_HANDLE_DISK_FULL`), `read_only` (EROFS, Windows
`ERROR_WRITE_PROTECT`), `permission_denied` (EACCES/EPERM, Windows `ERROR_ACCESS_DENIED`) or `io`. The frontend
turns these into plain-language messages. `permission_denied` says "folder read-only or file in use", because Windows
also reports a file held open by another program (antivirus, sync tools) as access denied.

## Crash recovery (`.recovery/`)

**Autosave writes snapshots, not the manuscript.** While the document has unsaved changes, Novel writes a snapshot to
`.recovery/manuscript.json` at most every 30 seconds. `manuscript.json` changes only when the user saves, so Save
keeps its meaning (the saved version is the one the user chose). Timing is a trailing throttle: the first change
after a snapshot starts one 30-second timer, and further typing does not restart it. A crash therefore loses at
most the last 30 seconds of typing. The document is serialized only when the timer fires, never on a keystroke.

The folder is created when needed (Rust `storage_ensure_dir`, confined to the project folder like every other
write). The file is written atomically, like the other project files. Compact UTF-8 JSON:

| Field           | Type    | Notes                                                                      |
| --------------- | ------- | -------------------------------------------------------------------------- |
| `format`        | string  | Always `"novel-recovery"`.                                                 |
| `version`       | integer | Recovery format version. Current: `1`. A newer version is ignored.         |
| `projectId`     | string  | `id` from project.json.                                                    |
| `savedAt`       | string  | ISO 8601 time of the snapshot.                                             |
| `baseUpdatedAt` | string  | project.json `updatedAt` (the last real save) when the snapshot was taken. |
| `docVersion`    | integer | Editor document version (diagnostic only).                                 |
| `doc`           | object  | The whole document, same shape as manuscript.json.                         |

```json
{"format":"novel-recovery","version":1,"projectId":"6f1c…","savedAt":"2026-11-03T10:16:12.004Z","baseUpdatedAt":"2026-11-03T10:15:42.120Z","docVersion":312,"doc":{"type":"doc","content":[…]}}
```

**On open.** Novel decides what to do with `.recovery/manuscript.json` by matching, never by comparing clocks:

1. `projectId` differs from project.json `id`: the snapshot belongs to another project. It is not offered and is
   moved aside.
2. `doc` is identical to manuscript.json: nothing to recover. The snapshot is deleted.
3. `baseUpdatedAt` equals project.json `updatedAt`: the snapshot was taken on top of the current save. It is offered.
4. `baseUpdatedAt` is something else: the snapshot was taken on top of a different save. It is not offered and is
   moved aside.
5. Only a snapshot with no `baseUpdatedAt` falls back to the clock: it is offered if `savedAt` is later than
   `updatedAt`, and otherwise moved aside.

Because only equality is checked, a clock change (or equal timestamps) can never cause a valid snapshot to be dropped.
A timestamp never causes a deletion. "Moved aside" means the file is renamed to
`.recovery/unrestored-<savedAt>.json` (`:` and `.` in the timestamp become `-`), which Novel never deletes; the user
can open it to copy text out. An offered snapshot gets **Restore** or **Discard Backup**:

- *Restore* loads the snapshot into the editor and marks it unsaved. Nothing on disk changes until the user saves,
  and the snapshot is kept until then, so a second crash still recovers it.
- *Discard Backup* deletes the snapshot. The editor keeps the saved manuscript.
- *Decide later* (the X, or Escape) decides nothing, and nothing is lost. The status bar then shows
  **Backup available — Restore…**, which brings the question back. That stays until something would replace or
  delete the snapshot: the next autosave snapshot (at most 30 s after the next edit), a Save, or "Don't Save". The
  snapshot is then first moved aside to `unrestored-<savedAt>.json` (see "Recovering a set-aside backup" below),
  the status bar says so, and it is no longer offered. If it cannot be moved aside, the new snapshot is not written,
  and the usual autosave warning and retry apply. If the user quits before any of that, the snapshot stays in place
  and is offered again the next time the project is opened.

A damaged snapshot, or one in an unknown format, is ignored and left in place. A recovery problem never stops a
project from opening.

**At startup.** If the most recent project has a `.recovery/manuscript.json` that would be offered by the rules
above (Rust `storage_probe_recent_recovery` reads just that file and project.json, and only for folders in the
recent list), Novel offers to reopen the project (**Reopen Project** / **Not Now**; the X is **Close** and does the
same as Not Now). Opening it then shows the Restore / Discard question above. Not Now leaves the snapshot where it
is: it is offered again at the next start while this is still the most recent project, and whenever the project is
opened.

**Set-aside backups on open.** When a project is opened and `.recovery/` holds `unrestored-*.json` files, the status
bar mentions it once ("1 older backup is kept in this project's .recovery folder."). No dialog appears; Novel never
deletes or restores these files itself.

### Recovering a set-aside backup

An `unrestored-<savedAt>.json` file has the snapshot format above; the text is in its `doc` field. To get it back:

1. Quit Novel (or open another project) so the project is not open.
2. Copy the project folder first, as a safety net.
3. Either copy the text you need out of the file's `doc` field with any text editor, or replace the manuscript
   with it: put the value of `doc` (the object starting with `{"type":"doc"`) into `manuscript.json`, replacing the
   whole file content.
4. Open the project in Novel. If the editor shows the text, save once. If `manuscript.json` is reported as damaged,
   restore it from your copy.

Delete `unrestored-*.json` files yourself once you no longer need them.

**Quitting without the quit flow.** Closing the window, File > Quit and Cmd/Ctrl+Q run the unsaved-changes prompt.
macOS Dock > Quit, logging off, and Windows shutdown/restart end the process without it (they do not reach the
app's exit handling). The same is true of a crash or a force-quit. In all of these cases the last snapshot in
`.recovery/` is what survives: at most the last 30 seconds of typing are lost, and the next start offers to recover
the rest.

**When recovery data is deleted:**

- after a save that leaves the document clean (manual save, or Save in the unsaved-changes prompt);
- on a clean quit: closing the window when there are no unsaved changes, or after saving;
- when the user chooses **Don't Save** in the unsaved-changes prompt (on quit, New Project or Open Project). The user
  explicitly threw those changes away, so Novel also stops snapshotting that content. Snapshots resume with the next
  edit;
- when the user chooses **Discard Backup**.

A snapshot that the user has not yet answered Restore / Discard for is never deleted. On quit it stays in place;
in every other case it is moved aside first.

**Errors.** If a snapshot cannot be written (disk full, read-only folder, permissions), the status bar shows a
warning such as "Autosave failed: the disk is full. Retrying in 5 s." No dialog appears. Retries happen after 5 s,
15 s, then every 30 s until a snapshot succeeds, which clears the warning.

Not in Phase 1: version history UI, cloud backup, and recovery for a document that was never saved as a project.

## Recent projects

Not part of a project. Stored in the app config directory as `recent-projects.json`
(e.g. `%APPDATA%\org.novel.app\` on Windows, `~/Library/Application Support/org.novel.app/` on macOS,
`~/.config/org.novel.app/` on Linux):

```json
{ "version": 1, "projects": [{ "path": "C:\\Books\\My Novel", "name": "My Novel", "openedAt": "2026-11-03T10:00:00.000Z" }] }
```

Only Rust writes this file (`storage_remember_recent` records the open project's folder; the webview supplies just
the display name and timestamp), because an entry here is what lets Open Recent reopen a folder without a dialog.
Most recent first, de-duplicated by folder, at most 10 entries. Folders that no longer contain a `project.json` are
shown as "(missing)" and disabled in File > Open Recent. A damaged file is treated as an empty list.
