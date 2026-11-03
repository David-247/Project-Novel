# Novel project format

A Novel project is an ordinary folder. Everything in it is readable without Novel: two JSON files and one SQLite
database. The folder name becomes the project title when the project is created.

```
My Novel/
├── project.json      metadata and schema version
├── manuscript.json   the manuscript as ProseMirror document JSON
└── index.sqlite      index (revisions); can be rebuilt, never the only copy of text
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

Every file is written atomically by the Rust command `storage_write_file_atomic`: the new contents go to
`<name>.tmp` in the same folder, the temp file is fsynced, then renamed over the original. A crash leaves either the
old or the new file, never a partial one. A leftover `*.tmp` file is safe to delete.

Save order: `manuscript.json`, then `project.json` (`updatedAt`), then a `revisions` row.

## Recent projects

Not part of a project. Stored in the app config directory as `recent-projects.json`
(e.g. `%APPDATA%\org.novel.app\` on Windows, `~/Library/Application Support/org.novel.app/` on macOS,
`~/.config/org.novel.app/` on Linux):

```json
{ "version": 1, "projects": [{ "path": "C:\\Books\\My Novel", "name": "My Novel", "openedAt": "2026-11-03T10:00:00.000Z" }] }
```

Most recent first, de-duplicated by folder, at most 10 entries. Folders that no longer contain a `project.json` are
shown as "(missing)" and disabled in File > Open Recent. A damaged file is treated as an empty list.
