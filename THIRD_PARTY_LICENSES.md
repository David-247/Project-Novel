# Third-party files bundled with Novel

Novel itself is MIT licensed ([LICENSE](LICENSE)). Its npm and Rust dependencies are checked by the licence gate
(`node scripts/check-licenses.mjs` and `cargo deny check licenses`; see README, "Licenses of dependencies"). This file
lists the third-party files shipped inside the app that are not packages. The gate checks each one is listed here,
has an allowed licence, and has its licence text in `src-tauri/resources/licenses/`, which is installed with the app
(`<resources>/licenses/`).

## Typst CLI 0.15.1 (PDF export engine)

- What: the `typst` command-line compiler, bundled as a Tauri sidecar (`bundle.externalBin`, `binaries/typst`). Novel
  runs it, unmodified, to create PDFs. It is downloaded and checksum-verified by `scripts/fetch-typst.mjs`
  (`https://github.com/typst/typst/releases/tag/v0.15.1`).
- Licence: `Apache-2.0 AND LPPL-1.3c` (embedded language data, unmodified). Typst itself is under the Apache
  License 2.0, full text: [src-tauri/resources/licenses/typst-LICENSE.txt](src-tauri/resources/licenses/typst-LICENSE.txt).
  The binary also contains data under the LaTeX Project Public License 1.3c (OSI-approved): per Typst's NOTICE, the
  translation tables adapted from Babel (LPPL 1.3 or later) and Cleveref (LPPL 1.2 or later). Novel redistributes
  them unmodified inside the unmodified binary, which the LPPL permits. The LPPL 1.3c full text (verbatim, from
  `https://www.latex-project.org/lppl/lppl-1-3c.txt`):
  [src-tauri/resources/licenses/lppl-1.3c.txt](src-tauri/resources/licenses/lppl-1.3c.txt).
- Notices: Typst's NOTICE file (third-party components inside Typst, under MIT, BSD-3-Clause, Apache-2.0 with LLVM
  exception, and the LPPL) is shipped verbatim:
  [src-tauri/resources/licenses/typst-NOTICE.txt](src-tauri/resources/licenses/typst-NOTICE.txt).
- Copyright: the Typst project developers.

## Liberation Fonts 2.1.5 (bundled fallback fonts)

- What: Liberation Serif (metric-compatible with Times New Roman) and Liberation Mono (metric-compatible with Courier
  New), regular, bold, italic and bold italic, in `<resources>/fonts/`. PDF export uses them when Times New Roman or
  Courier New is not installed, so the output is the same on every machine. Downloaded and checksum-verified by
  `scripts/fetch-typst.mjs` (`https://github.com/liberationfonts/liberation-fonts/releases/tag/2.1.5`).
- Licence: `OFL-1.1` (SIL Open Font License 1.1). Full text: [src-tauri/resources/licenses/liberation-fonts-LICENSE.txt](src-tauri/resources/licenses/liberation-fonts-LICENSE.txt).
- Copyright: Digitized data copyright (c) 2010 Google Corporation with Reserved Font Arimo, Tinos and Cousine;
  copyright (c) 2012 Red Hat, Inc. with Reserved Font Name Liberation.
- The fonts are embedded (subset) in exported PDFs, which the OFL permits.

## Rust crates added for the AI tutor (packages, recorded here as the Phase 5 plan asks)

These are packages, checked by `cargo deny check licenses` like every other crate; they ship compiled into the app
binary, not as separate files, so the bundled-file gate does not apply to them.

- `open` 5.4.5 (`MIT`, https://github.com/Byron/open-rs), with its `shellexecute-on-windows` feature, which adds
  `dunce` 1.0.5 (`CC0-1.0 OR MIT-0 OR Apache-2.0`). Opens the system browser from Rust for Sign in with OpenRouter and
  each provider's "Get a Key" page (`src-tauri/src/ai/oauth.rs`).
- `ring` 0.17.14 (`Apache-2.0 AND ISC`), already in the app as rustls' crypto provider, now also named directly for
  the PKCE verifier and its SHA-256 challenge.
- `reqwest` 0.13.5 (`MIT OR Apache-2.0`), without default features (`rustls-no-provider`): the HTTP client of the
  network proxy `ai_fetch` (`src-tauri/src/ai/fetch.rs`).
- `rustls` 0.23.46 (`Apache-2.0 OR ISC OR MIT`), with the `ring` provider, `std` and `tls12`: TLS for that client.
- `tokio` 1.54.1 (`MIT`): the async runtime pieces the proxy and the OAuth loopback listener use.
- `keyring` 3.6.3 (`MIT OR Apache-2.0`), with only the `apple-native` and `windows-native` backends: the OS keychain
  that holds provider keys (`src-tauri/src/ai/keychain.rs`).
- `harper-core` 1.5.1 (`Apache-2.0`, https://github.com/Automattic/harper): offline spell and grammar checking, with
  its bundled dictionary (`src-tauri/src/spellcheck.rs`). Ruling R10 keeps it on 1.5.1.

## npm packages added for the AI tutor (Phase 5)

Checked by `node scripts/check-licenses.mjs` like every other package, and bundled into the webview build. Versions are
pinned exactly in `package.json`.

- `ai` 7.0.162 (`Apache-2.0`, the Vercel AI SDK, https://github.com/vercel/ai): the tutor's agent loop, streaming and
  tool calls. Its own dependencies `@ai-sdk/provider`, `@ai-sdk/provider-utils` and `@ai-sdk/gateway` are also
  `Apache-2.0`.
- The SDK's provider packages, each used only by its adapter in `src/features/ai-tutor/providers/`, all `Apache-2.0`:
  `@ai-sdk/anthropic` 4.0.96, `@ai-sdk/openai` 4.0.108, `@ai-sdk/xai` 5.0.38, `@ai-sdk/deepseek` 3.0.79 and
  `@ai-sdk/openai-compatible` 3.0.84 (GLM, Qwen, OpenRouter, Ollama, LM Studio and custom endpoints).
- `zod` 4.6.7 (`MIT`): the tools' input schemas.
- `@radix-ui/react-context-menu` 2.4.1 (`MIT`): the manuscript's right-click menu (spelling suggestions, "Ask the
  Tutor About This").

The live ghostwriting suite (`pnpm test:tutor-live`) adds no dependency: it runs under the Vitest already in the
dev dependencies.
