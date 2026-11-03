# Novel

An open-source, fully offline desktop novel-writing app built with Tauri 2, React and TypeScript. MIT licensed.

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
live in IndexedDB, so closing a page is a "force-kill" and a new page is a "relaunch". Native-only UI
is driven through `window.__nvE2E` (see `e2e/helpers.ts`): File-menu events, the folder picker's
answer, and message boxes rendered as an overlay. Production builds never contain it
(`pnpm build && pnpm verify:prod-bundle` checks). `e2e/perf.spec.ts` writes its measurements to
`perf-results/`.

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
(`light`/`dark`), kept in sync by `useColorSchemeSync()`.

### App shell

`<AppShell toolbar={...} editor={...} statusBar={...} />` from `@/features/app-shell` is a slot-based layout; other slices plug in via props.

### Project storage

Projects are plain folders (`project.json`, `manuscript.json`, `index.sqlite`); see [docs/project-format.md](docs/project-format.md).
The storage slice talks to the editor only through the `DocumentProvider` contract in `src/shared/document.ts`.

## License

MIT, see [LICENSE](LICENSE).
