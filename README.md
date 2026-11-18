# Novel

An open-source, fully offline desktop novel-writing app built with Tauri 2, React and TypeScript. MIT licensed.

## For testers

Novel is a single continuous manuscript per project. A project is a folder (see
[docs/project-format.md](docs/project-format.md)).

**Start writing.** Launch Novel and type: the editor is ready immediately, before any project exists. That text lives
only in memory until you save it as a project (the status bar says "Not saved yet — choose Save as project to keep
your work").

**New, Open, Save.**

| Action | Windows / Linux | macOS | In the window |
| --- | --- | --- | --- |
| New project (choose an empty folder) | File > New Project…, Ctrl+Shift+N | File > New Project…, ⌘⇧N | status bar "New project…" (no project open) |
| Open project (choose its folder) | File > Open Project…, Ctrl+O | File > Open Project…, ⌘O | status bar "Open project…" (no project open) |
| Reopen a recent project | File > Open Recent | File > Open Recent | – |
| Save | File > Save, Ctrl+S | File > Save, ⌘S | status bar "Save as project…" (unsaved text, no project) |
| Quit | File > Quit Novel, Ctrl+Q, or close the window | Novel > Quit Novel, ⌘Q, or close the window | – |

Saving with no project open asks for a folder and creates the project there. Quitting or closing with unsaved
changes asks Save / Don't Save / Cancel. Reload and back/forward keys (F5, Ctrl/⌘+R, Alt+Left/Right) are disabled in
the app because they would throw away the page.

**Crash recovery, and its limits.** While a project has unsaved changes, Novel writes a backup to
`<project>/.recovery/manuscript.json` at most every 30 seconds (it never touches `manuscript.json`; only Save does).
After a crash, a force-quit, or a quit that skips Novel's quit prompt (macOS Dock > Quit, logging off, Windows
shutdown or restart), the next start offers to reopen the project and then **Restore** or **Discard Backup**. Limits:

- At most the last 30 seconds of typing can be lost.
- Text typed before the first save as a project is not backed up.
- **Decide later** (the X) keeps the backup; the status bar shows "Backup available — Restore…" until your next save
  or the next automatic backup. From then on the old backup is kept as `.recovery/unrestored-<time>.json`, and the
  status bar mentions such files when the project is opened. Novel never deletes them; to get text back from one,
  see "Recovering a set-aside backup" in [docs/project-format.md](docs/project-format.md).

### Book layout (Phase 2)

The manuscript is laid out as a printed book: pages on a desk, two facing pages at a time. Every control has a
tooltip (hover, or focus it with the keyboard). Book settings are saved with the project in `book.json`
(see [docs/project-format.md](docs/project-format.md)); the text stays in `manuscript.json`.

A quick tour: paste a few chapters (headings become chapters), then try each row below.

| Try | How | What to look for |
| --- | --- | --- |
| Trim size | Toolbar trim size button (shows e.g. "Trade 5.5 x 8.5 in") > pick a US or UK/EU size | The whole book reflows at once; the status bar page count changes. |
| Pages and spreads | Status bar: spread toggle (open book), zoom out / zoom / zoom in; PageUp / PageDown | "Pages 12–13 of 384"; Fit spread is the default; narrow windows show one page at a time. |
| Paragraph styles | Toolbar style picker; ⌘⌥0 / Ctrl+Alt+0 Body, ⌘⌥1 / Ctrl+Alt+1 Chapter Title | The paragraph takes the style; Enter after a Chapter Title gives a First Paragraph. |
| Change a style everywhere | Put the caret in a chapter title > Modify style (pilcrow-and-nib icon) > e.g. size 28 > Save | Every chapter title changes and the pages reflow; the text itself is not changed. |
| Your own styles | Manage styles > New / Duplicate / Rename / Delete | Built-in styles can be modified but not renamed or deleted. |
| Clear direct formatting | ⌘\ / Ctrl+\ or the struck-T button | The paragraph looks exactly like its style again. |
| Breaks | Insert > Page break, New chapter, Scene break; "Chapters start on" next page / right-hand page | Right-hand openings insert a blank left page when needed; `***` alone on a line becomes a scene break. |
| Footnotes | Insert > Footnote, or ⌘⌥F / Ctrl+Alt+F; Escape or Done returns to the text | A raised number in the text, the note at the bottom of the same page; long notes continue on the next page. Toolbar "Footnotes" sets numbering (whole book / per chapter), format and the separator line. |
| Running heads and page numbers | Toolbar Headers & page numbers, or double-click a header or footer | Author on left pages, title on right pages, numbers from 1 at the first chapter, nothing on chapter openings and blank pages. "Book details…" sets the title and author (after the first save). |
| Paper | Toolbar Paper picker: Auto, Book, White, Dark | Auto follows the OS light/dark mode; Book is cream paper on a walnut desk (warm dark paper in dark mode). |

**Save and reopen.** Everything above survives Save and reopening the project, and crash recovery restores unsaved
book settings together with the text.

**Known limitations (Phase 2).**

- Pages are laid out with the fonts installed on your computer, so the same manuscript can paginate slightly
  differently on macOS and Windows. The automated cross-engine check uses a bundled test font to separate engine
  differences from font differences (see "End-to-end tests").
- The AI tutor is a later phase (track changes and comments came in Phase 3, manuscript export in Phase 4, below).

## Development

Requirements: Node 22, pnpm 9, Rust (stable), and the Tauri 2 platform prerequisites (WebView2 on Windows, Xcode CLT on macOS).

```sh
pnpm install
pnpm fetch:typst   # PDF export engine + bundled fonts (needed before any cargo/tauri build)
pnpm tauri dev     # launch the desktop shell
pnpm dev           # web build only (Vite on :1420)
pnpm lint          # ESLint, incl. cross-slice import rule
pnpm typecheck
pnpm test          # Vitest (jsdom)
pnpm test:e2e      # Playwright e2e + perf, chromium and webkit (see below)
                   # (first run: pnpm exec playwright install chromium webkit)
pnpm tauri build   # production build
```

**PDF export engine.** PDF export runs the [Typst](https://typst.app) CLI as a Tauri sidecar (`bundle.externalBin`),
fully offline. `pnpm fetch:typst` (`scripts/fetch-typst.mjs`) downloads the pinned version (0.15.1) and the bundled
Liberation fonts, verifies their SHA-256 checksums, and puts them in `src-tauri/binaries/` and
`src-tauri/resources/fonts/` (both git-ignored; archives cached in `.cache/sidecar/`). tauri-build copies them at
compile time, so `cargo build`, `cargo test` and `pnpm tauri build` fail until it has run. For a universal macOS
build: `node scripts/fetch-typst.mjs --target universal-apple-darwin` (needs `lipo`).

### End-to-end tests

`pnpm test:e2e` builds the web app in e2e mode (`pnpm build:e2e` → `dist-e2e/`), serves it with
`vite preview` on port 4174 (override with `PW_PORT`), and runs `e2e/*.spec.ts` in Playwright's
chromium (stand-in for WebView2) and webkit (stand-in for macOS WKWebView). In e2e mode only,
`src/main.tsx` installs a fake Tauri backend (`src/test-utils/e2e-backend.ts`) whose project files
live in IndexedDB, so closing a page is a "force-kill" and a new page is a "relaunch". It runs the
same in-memory command core as the Vitest fakes (`src/test-utils/fake-tauri-core.ts`; a unit test
checks it handles every command the frontend invokes). Native-only UI
is driven through `window.__nvE2E` (see `e2e/helpers.ts`): File-menu events, the folder picker's
answer, and message boxes rendered as an overlay. Production builds never contain it
(`pnpm build && pnpm verify:prod-bundle` checks). `e2e/perf.spec.ts` (typing latency, Replace All,
and a combined hot path: typing with 10,000 live find matches while an autosave runs) writes its
measurements to `perf-results/`; it runs in its own projects (`perf-chromium`, then `perf-webkit`)
after the functional projects finish, so nothing else competes for the CPU while it measures. CI runs
perf in a separate job and puts the numbers in the job summary (`node scripts/perf-summary.mjs`).

Phase 2 (book layout) adds:

- `e2e/phase2-acceptance.spec.ts`: the acceptance scenario end to end (paste the 100k-word fixture, several trim
  sizes, a Chapter Title style edit, a footnote, page numbers, the four paper surfaces, save and reopen with an
  identical layout); it runs in the serial perf projects so its reflow budgets get a quiet CPU (in CI: the perf
  job). `e2e/phase2-tooltips.spec.ts` audits every Phase 2 control's tooltip in the spread view with
  each menu and dialog open; `e2e/phase2-contrast.spec.ts` measures WCAG AA contrast on the rendered spread for every
  paper surface in OS light and dark.
- Perf (`e2e/perf.spec.ts`, `e2e/pagination-perf.spec.ts`): typing in the spread view with 200 footnotes, the find
  panel open and an autosave mid-typing; trim size reflow for every catalog size; the Chapter Title style edit.
  Budgets (typing median < 50 ms, reflow < 1 s, style sheet swap < 100 ms, Replace All < 2 s) apply to
  the engine/OS pairs the app ships on, WebKit on macOS and Chromium on Windows (`e2e/budget.ts`). In CI only
  Windows Chromium blocks: GitHub's free macOS runner is too slow and noisy, so macOS misses are warnings there and
  the macOS budgets are enforced by running the perf specs on a real Mac. The other pairs report misses as warnings.
- Cross-engine page breaks: `e2e/pagination-fixture.spec.ts` typesets the fixture in a bundled OFL font at every
  trim size and writes chapter opening pages and page totals to `perf-results/pagination-fixture-*.json`. CI
  collects them from chromium and webkit on macOS and Windows and runs
  `node scripts/compare-pagination.mjs <dir> --require webkit-darwin,chromium-win32`: total pages may differ by at
  most max(2, 1 %), chapter openings by 1 page (2 for chapters that open on a right-hand page). A miss fails the
  job with a diff table in the job summary.

Phase 4 (manuscript export) adds:

- `e2e/phase4-acceptance.spec.ts`: the acceptance scenario. On the 100k-word fixture: the Navigation Pane jumps to
  chapters in Book and Scroll mode, and the word and page counts follow typing. On the wizard fixture: the wizard
  with a blocking check fixed through Fix, DOCX and PDF, settings through save, reopen and crash recovery, and Export
  Manuscript Again. The 100k-word book exports too, and an offline run (network off, the app's files from disk)
  exports with no outside request. The browser has no Typst, so the fake core returns a stub PDF. The test renders
  the request the app sent with the real sidecar, as Rust would, and reads it back with pdfjs-dist: title page,
  headers, page numbers, chapter openings. It needs `pnpm fetch:typst`, and without it the PDF checks are skipped
  (CI sets `NOVEL_REQUIRE_TYPST=1`). The files go to `e2e-exports/`. CI uploads them, and on macOS it also renders
  them with Quick Look and PDFKit (`scripts/render-pdf-pages.swift`), so they can be looked at as macOS draws them.
- `e2e/phase4-audits.spec.ts`: the tooltip audit with the pane, Word Count, every wizard step, File > Export, the
  ribbon's Export group and the export status open. AA contrast of all of them on the four paper surfaces in light
  and dark (the measurer in `e2e/contrast.ts`). The whole flow from the keyboard.
- Perf: IR build, DOCX export (`e2e/perf-export.spec.ts`), typing with the pane open and the outline after a trim
  reflow (`e2e/outline-perf.spec.ts`), and the PDF render of 100k words by the sidecar
  (`src/features/export/pdf/pdf.sidecar.test.ts`, in CI's Rust job). Budgets: IR build < 500 ms, DOCX < 5 s,
  PDF < 15 s, typing < 50 ms, outline caught up < 1 s after a trim change.

Real-app smoke (Windows/Linux only; WebDriver does not exist for macOS WKWebView): install
`tauri-driver` (`cargo install tauri-driver`) and an msedgedriver matching your WebView2 version
(`EDGEWEBDRIVER` may point at it or its folder), build the app, then
`node e2e-tauri/smoke.mjs src-tauri/target/release/novel.exe`. On Windows it tries tauri-driver first, then
`--mode attach`: it starts the app with a WebView2 DevTools port and attaches msedgedriver to it. CI does not
run it on pushes or pull requests: on GitHub's Windows runners WebView2 ignores the extra browser arguments both
modes rely on, so it could only fail. Run it locally as above, or by hand on a runner: Actions > "Real-app smoke
(manual)" > Run workflow (`.github/workflows/smoke.yml`, `workflow_dispatch`; or `gh workflow run smoke.yml`).

## Architecture

### Feature slices

`src/features/{editor,storage,tooltips,app-shell,book-settings,pagination,header-footer,footnotes,track-changes,comments,rewrite,menu,ribbon,settings,outline,export}/` are independent
slices; the shared book contract (types, trim sizes, styles, header/footer resolution) is `src/shared/book`. Each exposes **only** `src/features/<slice>/index.ts`
as its public interface. A slice may import another slice's `index.ts` (`@/features/other`) or `@/shared/*`, never its internals
(`@/features/other/x` or `../other/x`). ESLint (`no-restricted-imports` in `eslint.config.js`) enforces this; `tests/cross-slice-lint.test.ts`
proves it against fixtures. `src/App.tsx` is the composition root where slices are plugged together. `@/` aliases `src/`.

### Shared store (`src/shared/store`)

One Zustand store composed from slice creators, flux-style: state is read through selectors and changed **only** through named actions.

To add a state slice `foo`:

1. Create `src/shared/store/foo-slice.ts` exporting `interface FooSlice { foo: {...state}; fooActions: { doThing: (...) => void } }`
   and `createFooSlice: SliceCreator<FooSlice>`.
2. In `types.ts`: `export type RootState = AppSlice & FooSlice`.
3. In `index.ts`: spread `...createFooSlice(...a)` into the store.

Use it with `useStore((s) => s.foo.x)` and `useStore.getState().fooActions.doThing()`. The built-in `app` slice holds the OS color scheme
(`light`/`dark`), kept in sync with the OS by `useThemeFollow()` from `@/shared/theme` (the `prefers-color-scheme`
media query plus Tauri's window theme), which also writes `data-theme` on `<html>`. Call it once at the composition
root.

### App shell

`<AppShell toolbar={...} editor={...} statusBar={...} />` from `@/features/app-shell` is a slot-based layout; other slices plug in via props.

### Project storage

### Revision tools (Phase 3)

Version 0.3.0 adds the tools for revising a draft: track changes, comments and re-writes, plus a Word-style menu bar
and ribbon, Settings, and a Book view that turns pages like a book. Every control has a tooltip (hover, or focus it
with the keyboard), and everything below works from the keyboard. Below, "Mod" is ⌘ on macOS and Ctrl on Windows.

| Try | How | What to look for |
| --- | --- | --- |
| Menu bar and ribbon | macOS: the system menu bar. Windows: the menu bar in the window (Alt or F10 to reach it with the keyboard). The ribbon tabs are Home, Insert, Layout, Review and View. | Every command is in a menu, with its shortcut. In a narrow window, ribbon groups collapse into buttons and then into More. |
| Settings | File > Settings… (macOS: Novel > Settings…), Mod+, | Author name and colour (used for changes and comments), page navigation (Book or Continuous Scroll), Reduce motion, and the paper and trim size for new projects. |
| Book view (page turns) | The default. PageDown / PageUp, the arrows at the edges of the desk, a click or tap on the blank desk, a wheel or trackpad flick; View > Next / Previous / First / Last Spread | One spread at a time, turned like a book. When the caret moves off the spread (typing, arrow keys, Find, Next Change), the view turns with it. To use the Phase 2 continuous scroll instead, choose View > Continuous Scroll or change it in Settings. |
| Go to page | Click the page indicator in the status bar ("Pages 12–13 of 384"), or Mod+Alt+G | Type a page number and press Enter. |
| Track changes | Review > Track Changes (pen button), Mod+Shift+E, then edit | Inserted text is underlined, deleted text struck through, formatting changes get a dotted rule, and changed paragraphs a bar in the margin. The status bar counts the changes. Review > Markup switches between All Markup, Simple Markup, No Markup and Original. |
| Accept and reject | Click a change (or Alt+Enter) for its popover with Accept / Reject. Or use the Review tab: Accept / Reject (with Accept / Reject All and All by an author in their menus), Previous / Next Change (Mod+Alt+↑ / ↓), Accept and next (Mod+Alt+A), Reject and next (Mod+Alt+R) | Each accept or reject is one undo step. Accept All and Reject All ask first when there are more than 50 changes. |
| Comments | Select some text, then Review > New Comment, Mod+Alt+M. Mod+Enter adds it. | The text is highlighted and a card appears in the margin, level with its line. A card has Reply, Resolve / Reopen, Go to text and Delete, and each of these can be undone. Use Previous / Next Comment to move between comments, and Show Resolved to see resolved ones again. In a narrow window, the comments open in a drawer. |
| Re-write a passage | Select one or more paragraphs (at most one chapter), then Review > Re-write Passage…, Mod+Alt+W | The original and your revision appear side by side like facing pages, with removed words tinted on the left and added words on the right. New Version starts another version. The tabs switch between versions, and Mod+Alt+K flips the sides. Close keeps the draft, and the passage stays locked (a stitched bar in the margin). |
| Keep or discard | In the re-write: Keep This Version, Keep Original, or Discard | Keep This Version puts that version into the manuscript (as tracked changes while tracking is on). One Undo goes back to the original text with the re-write open again and every version kept. Review > Re-writes… lists open and resolved re-writes, and a resolved one can be reopened. |

**Save and reopen.** Changes, comments (`comments.json`) and re-writes (`rewrites.json`) survive Save and reopening
the project. Crash recovery restores the ones that were not saved yet, together with the text.

**Known limitations (Phase 3).**

- A pending paragraph join or split, while it is still tracked, shows as two paragraphs in No Markup and Original
  until the change is accepted or rejected (decision 5a4f5103; see [docs/track-changes.md](docs/track-changes.md)).
- There are no context menus (right-click). Every action is in the menu bar, the ribbon or a shortcut.
- Revision marks are not exported, and there are no AI suggestions or collaboration. These are later phases.

### Manuscript export (Phase 4)

Version 0.4.0 exports the book as a submission manuscript, a Word file (DOCX) and a PDF in standard manuscript format
(Shunn's "Proper Manuscript Format": Times New Roman 12 pt, double-spaced, 1 in margins, a title page, the running
header `Surname / Title / page`). It also adds a live word count and a Navigation Pane. Export runs fully offline, and
the PDF is typeset by the bundled Typst engine. Every control has a tooltip (hover, or focus it with the keyboard), and
everything below works from the keyboard. "Mod" is ⌘ on macOS and Ctrl on Windows.

| Try | How | What to look for |
| --- | --- | --- |
| Word count | The status bar ("84,212 words", or "120 of 84,212 words" with a selection). Review > Word Count, Mod+Shift+G, or a click on the status bar count | Counts follow your typing within a moment. The dialog shows words, characters, paragraphs, lines and pages. "Include footnotes" changes the count everywhere, the title page too. Pending tracked changes are counted as accepted. |
| Navigation Pane | View > Navigation Pane, Mod+Shift+O | Word's Headings pane: front matter, chapters and subheadings, each with its words and pages. A click, or the arrows and Enter, jumps there in Book and Scroll mode alike. Left and Right fold a chapter, and typing a letter finds a heading. Escape returns to the text. Drag the edge to resize. In a narrow window the pane floats over the pages. |
| Your author profile | File > Settings… (macOS: Novel > Settings…), Author profile | Legal name, pen name, address, phone, email and agent. They go on the title page of every export and stay on this computer, never in the project folder. The wizard can override them for one project. |
| Export a manuscript | File > Export > Manuscript…, Mod+Shift+X, or Layout > Export > Manuscript… | A four-step wizard: **Title page** (title, by-line, contact block, genre for the length check, word-count rounding, with a live preview), **Formatting** (Standard or Classic Courier preset, Letter or A4, scene break marker, end marker), **Checks**, **Export**. Alt+N and Alt+B go to the next and previous step, Alt+1 to Alt+4 to a step, Alt+E exports. |
| Checks before exporting | The Checks step | Length against the genre, pending tracked changes (exported as accepted), comments (never exported), open re-writes, chapter numbering gaps, untitled chapters, manual scene breaks, stray formatting, double spaces, a missing title, name or contact details. **Show me** closes the wizard and puts the cursor on the problem, and **Fix** goes to the field. A blocking check (no title, name or contact) disables Export until it is fixed. |
| Export | The Export step: choose DOCX, PDF or both, then Export | Each file goes where you choose in the Save dialog (the second dialog opens where the first file went). Progress and Cancel, then **Open file** and **Show in folder**. A cancel or an error leaves no partial file. Errors (a full disk, a folder you cannot write to, a PDF the engine could not make) come with Retry. |
| Export Manuscript Again | File > Export > Export Manuscript Again, Mod+Alt+Shift+X, or Layout > Export | The same settings to the same files: it asks before replacing them, then shows progress in the status bar, without the wizard. After a restart, the Save dialogs come back, because Novel only writes where you chose in this session. |

**What to check in the files.** Open the DOCX in Word (or LibreOffice, Pages) and the PDF in any reader:

- The title page: your contact block at the upper left, "about N words" at the upper right (rounded to the nearest
  100, or 500 from 20,000 words), the title a third of the way down, and "A Novel by …" below it. There is no header
  on the title page.
- The running header `Surname / Title / 1`, flush right, from the first page of text. The page numbers run on from
  there.
- Every chapter starts on a new page, a third of the way down, with scene breaks shown as a centred `#`.
- No revision marks or comments. Pending changes appear as accepted. The text is double-spaced, with a 0.5 in indent
  and no space between paragraphs.

**Save and reopen.** The export settings are saved with the project in `export.json` (see
[docs/project-format.md](docs/project-format.md)). They survive Save and reopening the project, and crash recovery
restores unsaved ones. The format rules, their sources and every option are in
[docs/manuscript-format.md](docs/manuscript-format.md). The DOCX details are in
[docs/docx-export.md](docs/docx-export.md).

**Known limitations (Phase 4).**

- Fonts: the PDF uses Times New Roman or Courier New when they are installed. Otherwise it uses the bundled Liberation
  Serif or Liberation Mono, which have the same metrics, and the wizard says which it used. The DOCX names the font,
  and Word substitutes it on a computer that lacks it.
- Footnotes are real footnotes. With the book's "per chapter" footnote numbering, the PDF restarts at each chapter, but
  Word numbers the DOCX through the document. Endnotes are not offered.
- There is no EPUB, direct submission or print-ready (trim size) PDF. Those are later phases. The export is the
  manuscript format, not the book layout on screen.
- The navigation pane does not reorder chapters by dragging.

Projects are plain folders (`project.json`, `manuscript.json`, `index.sqlite`); see [docs/project-format.md](docs/project-format.md).
The storage slice talks to the editor only through the `DocumentProvider` contract in `src/shared/document.ts`.

## Security and known limitations

- Novel makes no network calls. The webview loads only the bundled app under a strict Content Security Policy
  (`default-src 'self'`, see `src-tauri/tauri.conf.json`), with no remote content.
- Project files (`project.json`, `manuscript.json`, `.recovery/`) go through Rust commands confined to the project
  folder the user picked (or one from the Rust-written recent list); paths are canonicalized and symlinks are never
  overwritten.
- **Open decision: `tauri-plugin-sql` is unscoped.** `index.sqlite` is opened through the Tauri SQL plugin, which
  has no path scope: code running in the webview could open any SQLite file the user can read, or `ATTACH` one. This
  is mitigated by the CSP and the absence of remote content (no third-party code runs in the webview), but it is not
  enforced. Whether to scope or replace the plugin is an open decision for the maintainers.
- Quitting through macOS Dock > Quit, logoff, or Windows shutdown skips the unsaved-changes prompt; crash recovery
  limits the loss to the last 30 seconds (see above).

## License

MIT, see [LICENSE](LICENSE).

## Licenses of dependencies

Every dependency must be MIT-compatible (no GPL/AGPL/proprietary). CI enforces this:

- JS (production and dev): `node scripts/check-licenses.mjs` runs `pnpm licenses list --json` and fails on any
  license outside the allowlist (MIT, MIT-0, ISC, BSD-2-Clause, BSD-3-Clause, 0BSD, Apache-2.0, MPL-2.0, CC0-1.0,
  CC-BY-4.0 for data-only packages such as caniuse-lite, Unlicense, BlueOak-1.0.0).
- Rust: `cargo deny check licenses` in `src-tauri/` with the allowlist in `src-tauri/deny.toml` (adds Zlib,
  Unicode-3.0, BSL-1.0 and `Apache-2.0 WITH LLVM-exception`).
- Bundled files that are not packages (the Typst CLI sidecar, `Apache-2.0 AND LPPL-1.3c`; the Liberation fonts, OFL-1.1): the same
  script checks each is listed in [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) with its licence text in
  `src-tauri/resources/licenses/` (installed with the app), and that nothing in `bundle.externalBin` or
  `bundle.resources` is unlisted.

**MPL-2.0 (file-level copyleft).** These dependencies are used unmodified, so Novel's own code stays MIT; any change
to their files would have to be published under MPL-2.0:

- Rust (transitive, through `tauri-utils`' HTML processing via `dom_query`, and through `dirs`): `cssparser`,
  `cssparser-macros`, `dtoa-short`, `selectors`, `option-ext`.
- JS (dev only, build tooling via Tailwind CSS): `lightningcss` and its platform package.

**Bundled test font (test-only, not shipped).** `e2e/fixtures/fonts/` holds Libre Baskerville (regular and
bold WOFF2, from `@fontsource/libre-baskerville`) under the SIL Open Font License 1.1 (`e2e/fixtures/fonts/OFL.txt`).
The cross-engine pagination test loads it into the page; it is not part of the app or any build output.
