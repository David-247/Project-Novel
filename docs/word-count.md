# Word count (Phase 4)

The manuscript's live counts: the status bar ("98,412 words", "1,203 of 98,412 words") and Review ▸
Word Count…, as in Microsoft Word. The rules are one pure module shared by every slice that counts
(`src/shared/text/word-count.ts`); the editor slice applies them to the manuscript and publishes the
results to the shared store (`wordCount`), where the navigation pane and the export wizard read them.

- [What is counted](#what-is-counted)
- [Rules](#rules)
- [Comparison with Word](#comparison-with-word)
- [Engine and store](#engine-and-store)
- [Status bar and dialog](#status-bar-and-dialog)
- [Tests](#tests)

## What is counted

- **The text as it reads with every pending tracked change accepted** (the text export produces),
  whatever the markup view: inserted text counts, deleted text does not, a deleted paragraph mark joins
  the two paragraphs (`fo¶ar` with the ¶ deleted is one word, "foar"), and a deleted paragraph or break
  is gone. The helpers are `@/shared/track-changes`'s `acceptedText`, `isDeletedOnAccept` and
  `joinsPreviousOnAccept`, which follow `review.ts`'s Accept rules (docs/track-changes.md).
- **Footnotes**, by default, with Word's "Include footnotes" check box (Word: "Include textboxes,
  footnotes and endnotes"). A note is a paragraph of its own; its reference mark in the text is no
  character. The setting applies to the status bar too, as in Word. It is UI state for the session
  (not saved).
- **Never counted:** comments (marks plus `comments.json`) and re-write versions (`rewrites.json`):
  neither is document text. Breaks (page, scene, chapter) hold no text; a scene-break ornament is not
  counted.
- **Pages** are the laid-out pages (`layout.pages`; with a selection, the pages holding some of it,
  blank pages left out). **Lines** are the body lines as laid out on the pages (pagination slice,
  `countLines`; with a selection, the lines it touches). Lines leave out footnote areas and running heads.

## Rules

`src/shared/text/word-count.ts`, pure and DOM-free. Each rule has its test in
`src/shared/text/word-count.test.ts`.

| Rule | Examples |
| --- | --- |
| A **word** is a run of non-space characters holding at least one letter or digit (any script). | "The quick fox" = 3; "café Ελλάδα Москва" = 3 |
| A hyphenated word is one word. | "mother-in-law" = 1 |
| An **unspaced** em or en dash joins its neighbours; a spaced one is no word. | "waited—nothing" = 1; "waited — nothing" = 2 |
| Punctuation standing alone is no word. | "* * *" = 0; "Tom & Jerry" = 2 |
| Numbers are words, with their separators and signs. | "1,250.50" = 1; "$5 or 10%" = 3 |
| Apostrophes, slashes and ellipses stay inside a word. | "don't", "and/or", "wait...what" = 1 each |
| **Spaces** are every Unicode white space (space, tab, no-break, thin, ideographic) and line breaks. | "10 kg" with a no-break space = 2 |
| **Characters (with spaces)** count code points, line breaks excepted. | "a\tb" = 3 |
| **Characters (no spaces)** leave out every space too. | "Hi there" = 7 |
| A **paragraph** counts when it holds a non-space character (empty ones are left out). | an empty line = 0 |
| A paragraph whose preceding mark is deleted (accepted) joins the one before: no paragraph of its own, and its first run glues to the last run before it. | "fo" + "ar" = 1 word, 1 paragraph |

## Comparison with Word

The ticket asks for counts within 0.5 % of Word on the 100,000-word fixture exported as DOCX, checked
once by hand. The Phase 4 acceptance ticket checked it in Word 365 on Windows (COM automation,
2026-11-18):

- The 100,000-word fixture exported as DOCX: Word counts **100,017** words on 363 pages. The 17 extra
  words are the title page (contact block, "about 100,000 words", title and by-line), which is not
  manuscript text. The difference is 0.017 %.
- Single lines, Word against Novel: "He paused — then left." 4 / 4. "Salt & pepper, bread & butter."
  6 / 4. "She said - quietly - no." 6 / 4. "It was a well-known road—long and cold." 8 / 7.
  "Dr. Smith arrived at 10:30 a.m. with 3 friends." 9 / 9.

So Word counts a lone "&" and a spaced hyphen as words, and splits at an unspaced em dash. A spaced em
dash is not a word in either. Novel keeps its rules (the ticket's rule, and the convention of
manuscript word counts, which count words, not symbols). The title page rounds the count to the nearest
100 or 500 anyway. Rule by rule:

| Case | Word | Novel | Effect on a novel |
| --- | --- | --- | --- |
| Words split on spaces; hyphens and slashes keep one word | yes | yes | none |
| Unspaced em dash ("road—long") | two words (measured) | one word | Novel is lower by one per unspaced dash |
| Numbers | counted | counted | none |
| Punctuation alone between spaces | "&" and a spaced hyphen "-" are words; a spaced em dash "—" is not (measured) | not a word (the ticket's rule) | Novel is lower by the number of lone "&" and spaced hyphens: on the fixture 0 %, in prose usually far under 0.5 % |
| Characters (with spaces) | includes spaces and tabs; not paragraph marks | same | none |
| Manual line breaks | separate words; uncertain whether Word counts the break as a character | separate words; not a character | at most one character per break |
| Characters beyond the Basic Multilingual Plane (emoji) | may count UTF-16 units (2) | code points (1) | negligible in prose |
| Empty paragraphs | not counted | not counted | none |
| Paragraph of spaces only | uncertain | not counted | negligible |
| Footnotes | with "Include textboxes, footnotes and endnotes" | with "Include footnotes" | none |
| Tracked changes | Word counts the text as shown in the current markup view | always the accepted text | the ticket's rule: Novel matches the exported DOCX, which has the changes accepted |
| Scene-break ornament ("* * *") | a paragraph and its characters, if exported as text | not counted | a few characters and one paragraph per scene break; no words |

## Engine and store

**Engine** (`src/features/editor/word-count/count.ts`): `countManuscript(doc, chapters?)` and
`countRange(doc, from, to)`. What a top-level block contributes (each textblock's accepted text,
summarized, and its footnotes' counts) is cached in a `WeakMap` keyed on the immutable ProseMirror
node, so a keystroke reads one block again; a count is then one pass over the top-level blocks adding
cached numbers (joins resolved in that pass). Chapter totals use `getChapters(doc, styles, 'none')`
(the accepted text's chapter openings) and are the running count across each chapter's range, so the
chapters and the front matter add up to the book. A selection is `doc.cut(from, to)`: the blocks
inside it are the same nodes (cache hits); the two cut end blocks are read.

**Publishing** (`publisher.ts`): never in the keystroke. A transaction that changes the document or
the selection, a document load or a style sheet change arms one timer (`WORD_COUNT_THROTTLE_MS`,
150 ms); when it fires, the count runs in `requestIdleCallback` (timeout 400 ms; a plain task where
the engine has none, WebKit). `flushWordCount()` runs a pending count now (the dialog opening, tests).

**Store** (`src/shared/store/word-count-slice.ts`, `useStore((s) => s.wordCount)`):

```ts
interface TextCounts { words; charactersNoSpaces; charactersWithSpaces; paragraphs }
interface CountsWithNotes { body: TextCounts; footnotes: TextCounts; total: TextCounts } // total per includeFootnotes
wordCount: {
  ready: boolean                 // false until the mounted manuscript is counted once
  includeFootnotes: boolean      // Word's "Include footnotes" (default true)
  document: CountsWithNotes
  selection: (CountsWithNotes & { from; to }) | null   // null with a caret
  frontMatter: CountsWithNotes   // before the first chapter
  chapters: { index; title; from; to; counts: CountsWithNotes }[]   // getChapters order and ranges
  docVersion: number             // editor.docVersion counted
}
wordCountActions: { publish(raw), setIncludeFootnotes(on), reset() }
```

`publish` keeps the parts that did not change (same object), so a selector on one chapter re-renders
only when that chapter's counts change.

## Status bar and dialog

- **Status bar** (`WordCountIndicator`, before the page indicator): "98,412 words", "1 word", or
  "1,203 of 98,412 words" with a selection. A button that opens the dialog; no live region (it changes
  on every keystroke). In a narrow status bar (`statusbar` container) it shortens below 860 px
  ("1,203/98,412") and hides below 640 px, before the page indicator (560 px). Its accessible name is the
  visible text plus ". Word count".
- **Review ▸ Word Count…** (`review.wordCount`): first in the Review menu, and the ribbon's
  Review ▸ Proofing group (Word's place). Shortcut **Ctrl+Shift+G** / **Cmd+Shift+G** (Word's; free in
  the registry and in every Tiptap / ProseMirror keymap the editor loads). Guard `modal`: it opens from
  any field, not behind another dialog.
- **Dialog** (`WordCountDialog`): Pages, Words, Characters (no spaces), Characters (with spaces),
  Paragraphs, Lines, of the selection when there is one, else of the book; "Include footnotes"; Close.
  Live while open. Escape or Close gives the focus back (to the manuscript through its view, keeping
  the selection). Every control has a tooltip (tooltips registry: `wordCount.*`).

## Tests

- `src/shared/text/word-count.test.ts`: the rules (hyphens, dashes, numbers, punctuation, spaces,
  scripts, characters, joins).
- `src/shared/track-changes.test.ts`: accepted text.
- `src/features/editor/word-count/count.test.ts`: tracked insertions and deletions, joins, footnotes,
  breaks, lists, chapters, selections, and that a keystroke recounts one block.
- `src/features/editor/word-count/word-count-ui.test.tsx`: the status bar text, live and throttled
  updates, the store shape, the dialog (command, shortcut, statistics, Include footnotes, selection).
- `e2e/word-count.spec.ts` (chromium, webkit): typing and selection in the status bar, the dialog from
  the shortcut / ribbon / status bar by keyboard, tooltips, tracked changes, AA contrast light and dark.
- `e2e/perf.spec.ts`, "live word counts": typing on 100,000 words with the counts on (< 50 ms median,
  blocking on Windows Chromium, decision f040009b); the count's catch-up is reported
  (`scripts/perf-summary.mjs`, "Live word count").
