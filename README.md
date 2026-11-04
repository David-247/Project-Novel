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

Real-app smoke (Windows/Linux only; WebDriver does not exist for macOS WKWebView): install
`tauri-driver` (`cargo install tauri-driver`) and an msedgedriver matching your WebView2 version,
build the app, then `node e2e-tauri/smoke.mjs src-tauri/target/release/novel.exe`.

## Architecture

### Feature slices

`src/features/{editor,storage,tooltips,app-shell}/` are independent slices. Each exposes **only** `src/features/<slice>/index.ts`
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
