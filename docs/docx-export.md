# DOCX export (Phase 4)

The DOCX generator turns the manuscript IR (docs/manuscript-ir.md) into a Word file laid out by the rules in
docs/manuscript-format.md. Code: `src/features/export/docx/`, public through `@/features/export`.

## Using it

```ts
const renderer = createDocxRenderer()            // ManuscriptRenderer<DocxRenderSettings>
const bytes = await renderer.render(ir, { ...settings, info: { title, contact, language } }, { signal, onProgress })
await writeExportFile(target, bytes)             // the caller writes; a cancelled render returns nothing
```

- `DocxRenderSettings` is `ManuscriptSettings` plus `info`: the title, the resolved contact block
  (`getResolvedContact()`), the language (BCP 47, default `en-US`) and optionally the word count to round on
  the title page (default: `manuscriptWordCount(ir).total`, the IR's count with footnotes, which equals
  `countManuscript` on the document).
- `render` builds the file in a Web Worker (`worker.ts`; one worker per render, terminated afterwards). Where
  there is no Worker (Vitest) it builds in the page, loading the `docx` library on demand and yielding to the
  event loop between chapters. Either way the `docx` library is not in the app's main bundle.
- Progress: 0, then per chapter up to 0.5, then the packing (XML and zip, one step), then 1. Cancelling
  terminates the worker at once and rejects with an `AbortError`.
- Settings are trimmed at use: `fontFamily`, `sceneBreak`, `header.shortTitle` and the title.

## What the file contains

| Part | How |
|---|---|
| Title page | Its own section, no header (unless `header.startPage` is 1). Contact block single-spaced at the top margin with the word count on its first line at a right tab; title one third of the text area down (space before minus the contact lines); a blank double line; the by-line. |
| Body | `Normal`: the font and size, line spacing `480 / auto` (double; 360 = 1.5, 240 = single), 0 pt before and after, first-line indent from the settings (0.5 in), left-aligned, widow and orphan control. Hyphenation off in the document settings. |
| First paragraphs | `First Paragraph`: indented like any other unless `indentFirstParagraph` is off. |
| Chapters | `Heading 1` (Word's own, outline level 1): page break before, centred, space before = `chapterDropFraction` of the text area, one blank line after; number and title on separate lines (a line break). |
| Sections | Each chapter and part title starts a new section (next page) that names no header (Word links it to the previous one) and continues the numbering. Word drops a style's space before at the top of a page reached by "page break before", but keeps it after a section break: without the sections the heading would sit at the top of the page in Word. |
| Running header | `Header`, flush right, 0.5 in from the top edge: "Surname / Title / " and a real `PAGE` field. The text starts at 1 (or the title page is 1 and the text continues, with `startPage` 1). |
| Scene breaks | `Scene Break`: the settings' marker, centred, no indent. |
| Other roles | `Block Quote`, `Epigraph`, `Dedication`, `Centered`, `Flush Right`, `Heading 2` (subheadings), `Part Title` (page, drop), `List Paragraph` (the marker and a tab; nested items one indent deeper), `End Marker`. |
| Page breaks | The next paragraph gets "page break before" (no empty paragraph). A recto start is a page break: manuscripts are one-sided. |
| Emphasis | Bold, italic (underline in Classic, `italics: 'underline'`), underline, small caps, super- and subscript as run properties. Classic also puts two spaces after a sentence (not after Mr., Dr., initials...). |
| Footnotes | Real Word footnotes, `Footnote Text` in the body font and size, single-spaced. Word numbers them 1, 2, 3 through the document. |
| Properties | `docProps/core.xml`: title, author (the by-line name), last modified by, language; the text's proofing language in the document defaults. |
| Never | Tracked changes, comments, re-write versions (the IR has none). |

User text is cleaned of what XML 1.0 forbids (C0 controls, U+FFFE / U+FFFF, lone surrogates); the `docx`
library escapes `& < > " '`; emoji are kept.

## Tests

- `build.test.ts`: unzips the output and asserts the XML (sections, header and PAGE field, styles, chapters,
  footnotes, properties, no tracked-change or comment markup, escaping, trimming).
- `golden.test.ts`: the main parts for the feature fixture, Standard and Classic, against `__golden__/`.
- `renderer.test.ts`: the renderer contract in the page and through a (fake) worker.
- `word-count-parity.test.ts`: the IR count and the words in the .docx equal `countManuscript`.
- `e2e/docx-export.spec.ts`: the real worker and cancelling in the built app; `e2e/perf-export.spec.ts`: the
  100k-word export under 5 s (decision 1cedc290).

## Known limits

- Footnotes restarting per chapter (`book.footnotes` numbering) are numbered through the document in Word.
- List markers are text, not Word numbering (Word counts "3." as a word; the app does not).
- A LibreOffice "opens cleanly" check is not on CI (optional in the ticket); the file was checked by hand in
  Word (no repair prompt).
