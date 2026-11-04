# Novel project format

A Novel project is an ordinary folder. Everything in it is readable without Novel: three JSON files and one SQLite
database. The folder name becomes the project title when the project is created.

```
My Novel/
├── project.json      metadata and schema version
├── manuscript.json   the manuscript as ProseMirror document JSON
├── book.json         book layout settings (trim size, margins, styles, ...); optional
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
| `title`         | string  | Project title (the book title shown in running heads).           |
| `author`        | string  | Author name shown in running heads. Optional: a file without it (every earlier project) reads as `""`. Edited in the "Book details" dialog, which rewrites project.json at once (without changing `updatedAt`). |
| `createdAt`     | string  | ISO 8601 timestamp (UTC).                                        |
| `updatedAt`     | string  | ISO 8601 timestamp (UTC) of the last save. Only a save changes it: a Book details edit does not, because crash recovery matches snapshots to the last save by this value (`baseUpdatedAt`). |

```json
{
  "format": "novel-project",
  "schemaVersion": 1,
  "id": "6f1c1f0e-4f4e-4c55-9d43-2d6f1e0f3a10",
  "title": "My Novel",
  "author": "Ada Quill",
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
`text`. Paragraph/heading layout attributes (`textAlign`, `lineHeight`, `paragraphSpacing`, `indent`,
`firstLineIndent`) are written only when they differ from their defaults (`null`, or `0` for `indent`); a missing
one means the default.

```json
{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"It was a dark and stormy night."}]}]}
```

On open, the file must be valid JSON with this shape; otherwise Novel shows an error dialog ("manuscript.json is
damaged...") and does not open the project. The editor applies its own schema on load.

### Footnotes in the manuscript

A footnote is an inline node at its reference point, inside a paragraph or heading. Its content is the note text
(text nodes, with marks). Footnote numbers are not stored: they follow from document order and `book.json` →
`footnotes`.

```json
{"type":"paragraph","content":[{"type":"text","text":"A claim"},{"type":"footnote","content":[{"type":"text","text":"Smith, 1999, p. 4."}]},{"type":"text","text":" and more."}]}
```

An empty note is `{"type":"footnote"}`. Marks may sit on the footnote node itself and on its text.

### Paragraph and chapter styles in the manuscript

Paragraphs and headings may carry `attrs.styleId`, the id of a style in `book.json` → `styles` (lowercase letters,
digits and dashes). It is written only when set. Chapter styles (`kind: "chapter"`) are stored as `heading` nodes
at the style's `outlineLevel`; paragraph styles as `paragraph` nodes. Body on a paragraph is stored as no `styleId`.

**Phase 1 migration rule (rendering mapping, no rewrite):** a block without `styleId` uses **Body** if it is a
paragraph, **Chapter Title** if it is a level-1 heading and **Subheading** if it is a level-2 or level-3 heading.
The mapping happens when the block is rendered, so a Phase 1 `manuscript.json` loads and saves byte-for-byte
unchanged until the user applies a style. A `styleId` naming a style that no longer exists (for example brought back
by undo after a delete, pasted, or from an out-of-sync book.json) renders like Body on a paragraph, or like the
heading's migration default, and shows as "Body (missing style)" (or the heading default) in the picker. Deleting a
style in the app re-maps its blocks first.

### Styles in book.json (`styles`)

`styles` maps a style id to a record. It holds only what the user changed: `{}` means every built-in style at its
default. Unknown keys in a record are preserved.

| Field | Type | Notes |
|---|---|---|
| `name` | string | Display name (custom styles; a built-in may override it) |
| `kind` | `"paragraph"` \| `"chapter"` | Custom styles only |
| `basedOn` | style id | Unset formatting comes from this style (custom styles only) |
| `outlineLevel` | 1–3 | Heading level for chapter styles (default 1) |
| `nextStyle` | style id | Style of the paragraph Enter creates at the end of this one (default: same style) |
| `fontFamily` | string | Family name |
| `fontSize` | number, pt | |
| `fontWeight` | 100–900 | |
| `italic` | boolean | |
| `align` | `left` \| `center` \| `right` \| `justify` | |
| `lineHeight` | number | Multiple of the font size |
| `spaceBefore`, `spaceAfter` | number, pt | |
| `firstLineIndent`, `indentLeft`, `indentRight`, `letterSpacing` | number, em | |
| `textTransform` | `none` \| `uppercase` \| `lowercase` \| `capitalize` \| `small-caps` | |
| `breakBefore` | `none` \| `page` \| `recto` | Start a new page / right-hand page |
| `builtIn` | `false` | Written on custom styles |

For a built-in id the record is a partial override: a key equal to the built-in value is dropped, and `null` means
"unset" where the built-in sets a value (inherit from the parent instead). A custom style stores its full
definition. Built-ins: `body`, `first-paragraph`, `chapter-number`, `chapter-title`, `part-title`, `subheading`,
`scene-break`, `block-quote`, `epigraph`, `dedication`, `running-head` (defaults documented in `src/shared/book/styles.ts`).

## book.json

Book-level layout settings, written next to manuscript.json (Phase 2). Pretty-printed UTF-8 JSON, written atomically
like the other project files. A project without `book.json` (every Phase 1 project) opens with the defaults below;
the file is created at the next save.

| Field          | Type    | Notes                                                                                         |
| -------------- | ------- | --------------------------------------------------------------------------------------------- |
| `format`       | string  | Always `"novel-book"`.                                                                        |
| `version`      | integer | Format version. Current: `1`.                                                                 |
| `trimSize`     | string  | Trim size id from the list below. Default `"us-5.5x8.5"`.                                     |
| `margins`      | object  | `{ top, bottom, inside, outside }` in points (1/72 in), each a number from 0 to 7200. Default `{ 54, 54, 63, 45 }`. `inside` is the binding side, `outside` the fore-edge. |
| `styles`       | object  | Style definitions keyed by style id. Owned by the styles feature; default `{}`.               |
| `headerFooter` | object  | Running heads and page numbers; see "headerFooter" below. A missing or `{}` value is the defaults. |
| `footnotes`    | object  | Footnote options (below). Owned by the footnotes feature; default `{}`.                       |
| `surface`      | string  | Paper surface: `"auto"` (default), `"book"`, `"white"` or `"dark"`.                           |
| `view`         | string  | `"spread"` (default) or `"single"`.                                                           |

```json
{
  "format": "novel-book",
  "version": 1,
  "trimSize": "uk-a5",
  "margins": { "top": 56, "bottom": 56, "inside": 64, "outside": 46 },
  "styles": {},
  "headerFooter": {},
  "footnotes": {},
  "surface": "auto",
  "view": "spread"
}
```

### headerFooter

Written in full by Novel (an older or hand-written file may leave any field out: it is then the default).

| Field | Type | Notes |
| ----- | ---- | ----- |
| `verso` | `{ kind, text }` | Header of left-hand pages. `kind`: `"none"`, `"title"`, `"author"`, `"chapter"` or `"custom"` (then `text` is shown). Default `{ "kind": "author", "text": "" }`. |
| `recto` | `{ kind, text }` | Header of right-hand pages. Default `{ "kind": "title", "text": "" }`. |
| `pageNumber` | object | `position`: `"footer-centre"` (default), `"footer-outside"`, `"header-outside"` or `"none"`; `format`: `"arabic"` (default) or `"lower-roman"`, for the body; `start`: integer 0 to 9999, the number on the first body page (default `1`). |
| `frontMatter` | string | Pages before the first chapter: `"none"` (default, no number) or `"roman"` (i, ii, iii from the first page). |
| `restartAtFirstChapter` | boolean | Default `true`: the page where the first chapter starts gets `pageNumber.start`. `false`: page 1 gets it and front matter counts. |
| `suppressHeaderOnOpening`, `suppressNumberOnOpening` | boolean | Default `true`: no header / no number on a page where a chapter opens. |
| `suppressOnBlank` | boolean | Default `true`: no header and no number on blank pages (they still count). |

Pages before the first chapter never show a running head. A book without chapters is all body, numbered from page 1.
Invalid values fall back to their defaults individually (the status bar notes "the headers and footers"); unknown keys at the
**top level of `headerFooter`** are kept and written back (unknown keys nested inside `verso`, `recto` or `pageNumber` are not).
Roman numerals exist for 1 to 3999: with `format: "lower-roman"` a page whose number falls outside that range (for example a
`start` of 0) shows no number. What each page shows is computed from these settings, the layout and the chapter list; none of it
is stored in manuscript.json.

### footnotes

Every field optional; `{}` = the defaults; unknown keys are kept.

| Field       | Values                    | Default    | Meaning                                                    |
| ----------- | ------------------------- | ---------- | ---------------------------------------------------------- |
| `numbering` | `"book"`, `"chapter"`     | `"book"`   | Number through the whole book, or restart in each chapter. |
| `format`    | `"arabic"`, `"symbols"`   | `"arabic"` | 1, 2, 3 or `*`, `†`, `‡`, `§`, `‖`, `¶`, then `**`, `††`, ... |
| `separator` | boolean                   | `true`     | A short rule above the footnotes of each page.            |

An invalid value means the default (and is replaced at the next change of the options). The note text style is the
built-in Footnote Text style in `styles` (`footnote-text`).

**Trim sizes** (id: size): `us-5x8` (5 x 8 in), `us-5.25x8` (5.25 x 8 in), `us-5.5x8.5` (5.5 x 8.5 in, the default),
`us-6x9` (6 x 9 in), `us-mass-market` (4.25 x 6.87 in), `uk-a5` (148 x 210 mm), `uk-b-format` (129 x 198 mm),
`uk-royal` (156 x 234 mm), `uk-demy` (138 x 216 mm). Page geometry in CSS pixels is 96 per inch.

**Validation on open.** The file never blocks a project from opening, and `manuscript.json` is never touched:

- Damaged JSON, JSON that is not an object, or a file that could not be read (for example locked by antivirus or a
  sync tool): all settings are the defaults, and the status bar warns "book.json is damaged or could not be read ...".
  The file is then **left untouched**: saves do not write book.json until the user changes a book setting. Just
  before the first overwrite, the original is copied to `book.damaged-<timestamp>.json` in the project folder (best
  effort; an unreadable file is read again at that moment). Novel never deletes these copies. Creating a project
  (New Project, Save As) always writes book.json. The warning clears when book.json is written or the project closes.
- A field with an invalid value (unknown `trimSize`, a margin that is not a number from 0 to 7200, `styles`,
  `headerFooter` or `footnotes` that is not an object, unknown `surface` or `view`) falls back to its default. The
  other fields are kept, the status bar lists what was replaced, and the next save rewrites the file. A missing field is simply the default, with no
  warning.
- **Unknown top-level keys are kept** and written back on save, so a newer Novel's additions survive. The contents of
  `styles`, `headerFooter` and `footnotes` are opaque to this part of Novel and are preserved as they are.

Unsaved settings count as unsaved changes: the save status, the unsaved-changes prompts on close and quit, autosave
and crash recovery treat them exactly like unsaved text.

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
- New Project refuses a folder that already holds `manuscript.json`, `book.json` or `index.sqlite` without a `project.json`, so
  leftovers of an earlier project are never overwritten.
- The final rename is retried for about 0.4 s when another program (antivirus, OneDrive, Dropbox) briefly locks the
  target.
- **Known limitation:** `index.sqlite` is opened through the Tauri SQL plugin, which has no path scope. The webview
  could open a SQLite file anywhere. Only the JSON files go through the confined commands.

Save order: `manuscript.json`, then `book.json`, then `project.json` (`updatedAt`), then a `revisions` row. After a save that leaves
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
| `version`       | integer | Recovery format version. Current: `2`. A newer version is ignored.         |
| `projectId`     | string  | `id` from project.json.                                                    |
| `savedAt`       | string  | ISO 8601 time of the snapshot.                                             |
| `baseUpdatedAt` | string  | project.json `updatedAt` (the last real save) when the snapshot was taken. |
| `docVersion`    | integer | Editor document version (diagnostic only).                                 |
| `doc`           | object  | The whole document, same shape as manuscript.json.                         |
| `book`          | object  | Book settings at snapshot time, same shape as book.json. Added in version 2; a version 1 snapshot has none and restores only the text. |

```json
{"format":"novel-recovery","version":1,"projectId":"6f1c…","savedAt":"2026-11-03T10:16:12.004Z","baseUpdatedAt":"2026-11-03T10:15:42.120Z","docVersion":312,"doc":{"type":"doc","content":[…]}}
```

**On open.** Novel decides what to do with `.recovery/manuscript.json` by matching, never by comparing clocks:

1. `projectId` differs from project.json `id`: the snapshot belongs to another project. It is not offered and is
   moved aside.
2. `doc` is identical to manuscript.json, and `book` (if present, stored in book.json shape with unknown keys at top level) equals the settings loaded from book.json: nothing
   to recover. The snapshot is deleted.
3. `baseUpdatedAt` equals project.json `updatedAt`: the snapshot was taken on top of the current save. It is offered.
4. `baseUpdatedAt` is something else: the snapshot was taken on top of a different save. It is not offered and is
   moved aside.
5. Only a snapshot with no `baseUpdatedAt` falls back to the clock: it is offered if `savedAt` is later than
   `updatedAt`, and otherwise moved aside.

Because only equality is checked, a clock change (or equal timestamps) can never cause a valid snapshot to be dropped.
A timestamp never causes a deletion. "Moved aside" means the file is renamed to
`.recovery/unrestored-<savedAt>.json` (`:` and `.` in the timestamp become `-`), which Novel never deletes; the user
can open it to copy text out. An offered snapshot gets **Restore** or **Discard Backup**:

- *Restore* loads the snapshot into the editor (with its book settings, if it has them) and marks it unsaved. Nothing on disk changes until the user saves,
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
