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
- Export (PDF, DOCX), track changes, comments and the AI tutor are later phases.

## Development

Requirements: Node 22, pnpm 9, Rust (stable), and the Tauri 2 platform prerequisites (WebView2 on Windows, Xcode CLT on macOS).

```sh
pnpm install
pnpm tauri dev     # launch the desktop shell
pnpm dev           # web build only (Vite on :1420)
pnpm lint          # ESLint, incl. cross-slice import rule
pnpm typecheck
pnpm test          # Vitest (jsdom)
pnpm test:e2e      # Playwright e2e + perf, chromium and webkit (see below)
                   # (first run: pnpm exec playwright install chromium webkit)
pnpm tauri build   # production build
```

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
  Budgets (typing median < 50 ms, reflow < 1 s, style sheet swap < 100 ms, Replace All < 2 s) are blocking only on
  the engine/OS pairs the app ships on, WebKit on macOS and Chromium on Windows (`e2e/budget.ts`); the other pairs
  report misses as warnings.
- Cross-engine page breaks: `e2e/pagination-fixture.spec.ts` typesets the fixture in a bundled OFL font at every
  trim size and writes chapter opening pages and page totals to `perf-results/pagination-fixture-*.json`. CI
  collects them from chromium and webkit on macOS and Windows and runs
  `node scripts/compare-pagination.mjs <dir> --require webkit-darwin,chromium-win32`: total pages may differ by at
  most max(2, 1 %), chapter openings by 1 page (2 for chapters that open on a right-hand page). A miss fails the
  job with a diff table in the job summary.

Real-app smoke (Windows/Linux only; WebDriver does not exist for macOS WKWebView): install
`tauri-driver` (`cargo install tauri-driver`) and an msedgedriver matching your WebView2 version
(`EDGEWEBDRIVER` may point at it or its folder), build the app, then
`node e2e-tauri/smoke.mjs src-tauri/target/release/novel.exe`. On Windows it tries tauri-driver first, then
`--mode attach`: it starts the app with a WebView2 DevTools port and attaches msedgedriver to it.

## Architecture

### Feature slices

`src/features/{editor,storage,tooltips,app-shell,book-settings,pagination,header-footer,footnotes}/` are independent
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

**MPL-2.0 (file-level copyleft).** These dependencies are used unmodified, so Novel's own code stays MIT; any change
to their files would have to be published under MPL-2.0:

- Rust (transitive, through `tauri-utils`' HTML processing via `dom_query`, and through `dirs`): `cssparser`,
  `cssparser-macros`, `dtoa-short`, `selectors`, `option-ext`.
- JS (dev only, build tooling via Tailwind CSS): `lightningcss` and its platform package.

**Bundled test font (test-only, not shipped).** `e2e/fixtures/fonts/` holds Libre Baskerville (regular and
bold WOFF2, from `@fontsource/libre-baskerville`) under the SIL Open Font License 1.1 (`e2e/fixtures/fonts/OFL.txt`).
The cross-engine pagination test loads it into the page; it is not part of the app or any build output.
