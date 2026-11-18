# Manuscript IR and renderer contract (Phase 4)

The `export` slice turns the manuscript into publisher-ready files. Every format starts from one
intermediate representation, the **manuscript IR** (`src/features/export/ir/`, public through the slice
index `@/features/export`): the DOCX generator, the PDF generator (Typst sidecar) and the export wizard
build against it. EPUB (out of scope for Phase 4) will read the same IR; `MANUSCRIPT_IR_VERSION` versions it.

## Building it

```ts
buildManuscript(doc, styles, { footnotes, openRewriteAnchors, schema }) → ManuscriptIR
```

- `doc`: the ProseMirror document (`editor.state.doc`) or its JSON (manuscript.json; `schema` defaults to
  the editor's). `styles`: `getResolvedStyles()` or `book.styles` as stored. `footnotes`: `book.footnotes`.
  `openRewriteAnchors`: anchors of the open re-writes (default: every anchor in the document).
- Pure: no store, no DOM, input unchanged; the result is plain JSON (it can come back from a Web Worker).
- Speed: 100k words in well under 500 ms in the page (`e2e/perf-export.spec.ts`), so it runs on the main
  thread today; the JSON entry point is there for a worker if the wizard needs one.

Steps:

1. **Track changes are resolved as accepted** with the track-changes slice's `acceptAll` (decision
   1cedc290): deleted text and footnotes go, insertions stay, a format change keeps the new formatting,
   joins join, splits split, inserted breaks stay and deleted ones go, style changes keep the new style.
   The text is what No Markup shows, whatever view is on screen.
2. **Structure**: front matter (before the first chapter), then chapters from `getChapters` (Chapter Title,
   level-1 chapter styles based on it, unstyled level-1 headings), each with its Chapter Number block(s)
   and title. A document without a chapter title is all front matter.
3. **Blocks** get a role: `body`, `first` (the first prose paragraph after a chapter title, subheading, part
   title or scene break: an epigraph, block quote or aligned line right after a heading does not use it up;
   or styled First Paragraph or a style based on it), `blockQuote` (Block Quote, Epigraph and styles based on
   them), `subheading` (level 2–3), `partTitle` (a level-1 chapter style that opens no chapter), `aligned`
   (centre / right, direct or from the style), `listItem` (lists are flattened: marker "•", "◦", "▪" or
   "3.", and depth). Every paragraph also carries its rendered `styleId`, and `variant: 'epigraph' |
   'dedication'` for those styles (an epigraph style's italic is kept as italic runs).
4. **Breaks**: `sceneBreak` from the node (`source: 'node'`) or from a manual one (`'manual'`: "***",
   "* * *", "#", "###", "❦", "⁂", or a Scene Break paragraph, without a footnote; or empty paragraphs between
   two prose (`body` / `first`) paragraphs of a chapter). Blank lines are spacing, not breaks, when they
   separate most prose paragraphs (8 pairs or more, over half blank-separated: `report.blankLineSpacing`),
   or with the option `blankLineSceneBreaks: 'off'`. `pageBreak` (left out right before a chapter or at the
   end); `sectionBreak` (`page` / `recto`) before a block whose style starts a page outside a chapter
   opening (Part Title, Dedication), once per heading group (as the editor's page starts).
5. **Runs**: text with `bold`, `italic`, `underline` (and `smallCaps`, `superscript`, `subscript` when the
   schema has such marks), line breaks and footnote references. Fonts, sizes, line spacing and indents are
   dropped: the manuscript format replaces book styling.
6. **Footnotes** in document order, numbered by `book.footnotes` (through the book or per chapter), with
   their text runs. Other empty paragraphs are left out.

`report` counts what was resolved or dropped, for the wizard's checks: pending changes by kind, comment
threads, open re-writes, the manual scene breaks normalised, stripped fonts / sizes / paragraph layout,
empty paragraphs and redundant page breaks. Comments, re-write versions and review highlights are never
in the IR.

## Renderer contract

```ts
interface ManuscriptRenderer<TSettings> {
  format: 'docx' | 'pdf' | 'text'; mimeType: string; fileExtension: string
  render(ir, settings, { signal, onProgress }): Promise<Uint8Array>
}
```

- `assertManuscriptVersion(ir)` first (rejects `UnsupportedManuscriptVersionError`).
- `signal`: check before starting and between units of work; reject with `abortError()` (an `AbortError`).
- `onProgress({ fraction, done?, total?, stage? })`: `fraction` 0 → 1, never decreasing, 1 last.
- Never mutate the IR or the settings; no network; resolve with the file's bytes (the caller writes them).
- `TSettings` defaults to `ManuscriptSettings` (the export settings, src/features/export/settings/types.ts).

Renderers print their own scene-break marker (never `original`), chapter openings from `number` / `title`,
and number footnotes with `number` (`label` is the book's symbol form).

## Fixtures

- `FEATURE_FIXTURE_DOC` (+ `FEATURE_FIXTURE_STYLES`, `FEATURE_FIXTURE_FOOTNOTES`): every feature above.
  `FIXTURE_MANUSCRIPT_IR` is its IR (golden, `build.test.ts`).
- `createMockRenderer()`: keeps the contract; the bytes are `manuscriptPlainText(ir, { footnotes: true })`.
- 100k words: `buildPaginationFixture()` (e2e/fixtures/pagination-manuscript.ts).

Word-count parity (IR text vs. the live word count) is checked in the Wave 2 DOCX / PDF tickets, once the
word count engine is merged (ruling R2); `manuscriptPlainText` is the IR side.
