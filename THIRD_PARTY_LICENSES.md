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
