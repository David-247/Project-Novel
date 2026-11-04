# Pagination (Phase 2)

The `pagination` slice (`src/features/pagination/`, public interface `index.ts`) flows the
manuscript across fixed-size book pages and shows them as a two-page spread. The writer types
directly on the pages: there is one ProseMirror view, and it stays the single source of truth.

- [ADR: layout strategy](#adr-001-shifted-stream-pagination)
- [How a pass works](#how-a-pass-works)
- [Layout model (`layout` store slice)](#layout-model)
- [Page-break contract (`breakBefore`)](#page-break-contract)
- [Extension points](#extension-points)
- [View, zoom, keys](#view-zoom-and-keys)
- [Tests and fixtures](#tests-and-fixtures)

---

## ADR-001: shifted-stream pagination

**Status:** accepted (Phase 2, ticket "Pagination engine and default two-page spread view").

### Context

Hard requirements: one editable view (no read-only preview), line-level fragmentation with
widows/orphans, mirrored margins, a two-page spread by default, trim-size reflow of 100,000 words
in under 1 s and median typing latency under 50 ms in both Chromium (≈ WebView2) and WebKit
(≈ WKWebView), and a bounded DOM cost.

A single `contenteditable` can only put one paragraph's lines side by side through CSS
fragmentation (multi-column). Everything else lays a block out in one place. So the candidates were:

| | Strategy | How the spread is made |
|---|---|---|
| A | **Measure-and-break**: one column of text-block width; line boxes measured; page breaks computed in JS; spacer widgets inserted at the breaks (page-gap decorations). | Not possible: the stream is one vertical column. Single pages only. |
| B | **CSS multi-column**: the editor root is a multicol container; each column is a page (`column-width` = text width, `height` = text height, `column-fill: auto`); the engine fragments lines (`widows`/`orphans`). | Columns run horizontally: a strip of pages. |
| C | **B + containment**: blocks that do not straddle a page get `content-visibility: auto` with their measured size. | As B. |
| D | **Hybrid "shifted stream"**: A's measurement and JS breaking, but no spacers. The stream stays a natural single column; every page's content is *moved* to its page with `position: relative` offsets: a node decoration per block, and an inline decoration (an offset difference) for the lines of a paragraph that continue on the next page. | Offsets are arbitrary 2-D vectors: verso left, recto right, rows of spreads stacked vertically. |

### Measurements

`node scripts/pagination-spike.mjs` (reproducible; Playwright 1.64 chromium and webkit, Windows 11,
the Phase 1 perf manuscript: 100,000 words, 960 paragraphs + 40 headings, bare `contenteditable`,
15px Georgia, 5.5 × 8.5 in page, text block 384 × 672 px). Times in ms. "Trim" = 5.5 × 8.5 → 6 × 9 in
including relayout, measuring, breaking and applying. Typing = real key presses at the end of
paragraph 500, keydown → next frame painted, median / p95 of 31 after 5 warm-up.

| Strategy | Engine | Initial layout | Trim → 6 × 9 | Trim back | Typing median / p95 |
|---|---|---|---|---|---|
| A measure-and-break | chromium | 112 | 85 | 90 | 17.5 / 18.6 |
| | webkit | 98 | 76 | 102 | 7 / 45 |
| B CSS multicol | chromium | 57 | 33 | 39 | 21.8 / 26.7 |
| | webkit | 70 | 43 | 47 | **60 / 73** |
| C multicol + containment | chromium | 89 | 59 | 101 | 21.5 / 23.7 |
| | webkit | 91 | 75 | 83 | 44 / 54 |
| **D shifted stream** | chromium | 108 | 100 | 100 | 16.6 / 17.7 |
| | webkit | 147 | 144 | 166 | 10 / 45 |

D's breakdown (chromium / webkit, trim to 6 × 9): relayout 43 / 59, measure line boxes 13.5 / 11,
break 0.4 / 0, find line-start positions 4.3 / 20, apply offsets + relayout 38.6 / 54. A check in the
spike re-measured every page after applying the offsets: the first line of all 444 (360) pages was
painted exactly at its page's text-block top in both engines (`misplaced: 0`), i.e. the offsets
never changed line breaking.

### Decision

**D, the shifted stream.**

- B fails the typing budget in WebKit (60 ms median before ProseMirror adds anything): in a
  multicol flow every keystroke relays out the whole fragmented flow. C only gets under the line
  with a 54 ms p95 and makes the page breaks depend on what is on screen.
- A is the fastest to type in, but cannot show a spread with one view.
- D keeps A's cheap, incremental typing path (the browser relays out one paragraph; the engine
  re-measures one block) and gets the spread from the offsets. Its full reflow is well under the
  1 s budget in both engines.

**How the spread is achieved with a single view:** the editor DOM is laid out once, as a column the
width of the text block. The engine knows, for every line, which page it belongs to; each page has
one offset (canvas position of its text block minus the stream position of its first line). Blocks
get that offset with `position: relative; left; top` (node decorations); the lines of a paragraph
that continue on page *p + 1* are wrapped by an inline decoration carrying the difference between
the two pages' offsets. Relative positioning moves painting, hit testing, carets and selection
highlights, but never layout, so line breaks are the same before and after the offsets are applied
(measurement never feeds back on itself). Page frames (paper, header/footer regions) are a separate
layer behind the editor.

### Consequences

- Layout and paint coordinates differ. The engine subtracts its own offsets (`data-nv-dy`) when it
  measures; clicks on margins, the desk or the gaps between paragraphs are mapped to the nearest line
  of the nearest page by the slice (the browser would guess from layout coordinates).
- A caret at a page boundary inside a paragraph is ambiguous (end of the last line on one page = start
  of the first line of the next). The slice draws it at the top of the page when it put it there
  (PageDown, a press on a page).
- Native vertical caret movement follows the layout column, where the next page's first line sits
  right below the previous page's last line with no horizontal offset. ArrowDown on a page's last line
  and ArrowUp on its first line are therefore handled by the slice: the caret goes to the painted
  first (last) line of the next (previous) page at the same column, hit-tested with the browser's
  caret-from-point on painted boxes (Shift extends). Every other arrow press stays native.
- Off-screen cost is bounded: unchanged blocks are never re-measured (cache keyed by node identity),
  page frames are virtualised to the rows near the viewport, and the browser lays out only changed
  blocks. `content-visibility` was not needed to meet the budget (see the perf numbers below) and is
  left out: it would make measurement of skipped blocks expensive on a trim change.

### Measured in the app

`CI=1 pnpm exec playwright test e2e/pagination-perf.spec.ts --project=perf-chromium --project=perf-webkit --no-deps --workers=1`
(deterministic 100k-word, 30-chapter fixture, real app with ProseMirror, project opened from disk):

| Measure (budget) | chromium | webkit |
|---|---|---|
| Trim reflow complete, worst of 6 × 9 / 5 × 8 / A5 / 5.5 × 8.5 (< 1000 ms) | 161–254 ms | 341–499 ms (quieter host); 602–1306 ms under background load |
| … every off-screen block drawn as well (reported, < 3000 ms) | 342–537 ms | 658–935 ms (quieter); up to 2066 ms under load |
| Typing at a line end mid-manuscript, median / p95 (< 50 ms median) | 18.1 / 27.7 ms | 47–52 / 76–98 ms |
| Typing inside a paragraph split across two pages, median / p95 | 22.1 / 32.3 ms | 44–50 / 54–61 ms |
| Phase 1 `perf.spec.ts` typing (now paginated), median / p95 | 14.1 / 25.4 ms | 38–48 / 58–90 ms |
| Phase 1 hot path (find on "the" + autosave), median / p95 | 17.9 / 30.7 ms | 42–46 / 61–80 ms |
| Chapter Title restyle: style sheet swap (< 100 ms) / repaginated (< 1000 ms) | 23.5–37 / 139–385 ms | 71–87 / 437–774 ms (1247 under load) |

Windows 11, Playwright 1.64, measured while other processes kept the CPU between ~30 % and ~90 %
busy (not under our control); the ranges are the runs of this round. CI on macOS is the arbiter.
Measured after merging the book settings, styles and paper surfaces tickets (book styles, textured
paper). 440 pages at 5.5 × 8.5 in. A keystroke's pass costs 1–3 ms (one block measured, two element
boxes read, decorations untouched unless a line moved between pages). Playwright's WebKit on Windows
is bimodal for every build, Phase 1's continuous editor included: some keystrokes paint in the same
frame, the rest slip to about 44 ms; the WebKit medians sit on that second mode. A line that moves
between pages re-decorates the rest of the book (the p95 / max cases).

---

## How a pass works

`engine.ts`. A pass runs in `requestAnimationFrame` (before paint) after a document change, a trim
size / margin / view change, a font load, or `invalidatePagination()`.

1. **Measure** (`measure.ts`). For each top-level block whose node changed (or after a geometry
   change): text and `<br>` fragments of each textblock (`Range.getClientRects`), grouped into line
   boxes, in "stream px" (unscaled, page offsets subtracted). Cached by node identity. A change to
   `book.styles` re-measures only the blocks whose `data-style` resolves differently. Unchanged
   blocks keep their last stream top plus the shift of changed blocks above them (moves under
   0.1 px are box snapping, not moves).
2. **Break** (`breaker.ts`, pure, unit-tested). Fill lines while `bottom − top of page ≤ text
   height`; forced breaks; widows / orphans 2; keep headings with the next block; bottom
   reservations; at least one line per page.
3. **Place and decorate** (`placement.ts`). Page offsets from the spread / single placement;
   decorations rebuilt only when a block's offsets or split positions changed (per-block
   signatures), otherwise ProseMirror's mapping keeps them right. When more than 160 blocks
   changed (a trim size change, a restyle that moves every break), the blocks on the pages in the
   scroll viewport (±2 pages) and around the caret are drawn in the pass; the others follow in the
   next frames, 120 per frame, nearest first.
4. **Publish** the page model to the store.

A trim size or margin change runs its pass synchronously, in the task that changed the setting, so
the browser never lays out and paints one frame of the whole book at the new width with the old
offsets (in WebKit that frame cost 200–300 ms).

**Reflow complete** means: the new page model (every page break of the book, `pages[]`,
`pageCount`, `layoutVersion`) is published, and the pages in view are drawn at their new place and
painted. Blocks not redrawn yet keep their old offsets for a few frames, and against the new
placement those can land anywhere, the viewport included; so in the same dispatch every such block
gets `.nv-stale` (`visibility: hidden`, which keeps layout and line metrics) until it is redrawn.
An e2e test samples every frame after a trim change (two trims, two scroll positions, both engines)
and fails if any visible block is painted anywhere but its final place. Scrolling to the selection
(ProseMirror `scrollIntoView`, e.g. Mod-End) and the find panel's reveal of the current match
finish the pending frames first (`handleScrollToSelection`, the editor's `setFindRevealHook`).
Large document changes (Replace All of a common word, a restyle) take the same path: dirty blocks
in view first, the rest progressively.
Anything that needs them all (hit tests for the arrow keys and presses on the desk, PageUp/Down)
finishes the pending frames first. `getPaginationDebug().modelSettled` is "reflow complete";
`settled` is "every block drawn". The perf test asserts the first < 1 s and reports (and caps at 3 s)
the second.

The pass never redraws under an IME composition or a pointer drag, and first takes in DOM changes the
browser made but ProseMirror has not read (so a native caret move is not undone).

## Layout model

Store slice `layout` (`src/shared/store/layout-slice.ts`, actions `layoutActions`):

| Field | Meaning |
|---|---|
| `pageCount` | `pages.length` |
| `pages[]` | `{ index, side, from, to, isBlank, startsBlockType, chapterIndex }` |
| `currentPage` | index of the page holding the selection head (never a blank page) |
| `visibleSpread` | `{ index, first, last }`: the spread (row) at the middle of the window and its first/last page index; in single view one page |
| `effectiveView` | `'spread'` or `'single'` actually shown |
| `zoom`, `scale` | zoom choice (`fit-spread`, `fit-width`, `percent`) and the resolved scale |
| `layoutVersion` | bumps on every published reflow |

`pages[]`: page 0 is a **recto** (right-hand page, as the first page of a printed book); even index =
recto, odd = verso. Pages tile the document as half-open ranges `[from, to)`: page 0 starts at 0, the
last page ends at `doc.content.size`, `pages[i].to === pages[i + 1].from`. A page that starts with a
block starts at that block's position (just before the node); a page that starts mid-paragraph starts
at the first character of its first line. A blank page (left by a recto break) has `from === to`.
`startsBlockType` is the node type of the block beginning at the top of the page, `null` when the page
starts in the middle of a block. `chapterIndex` is the 0-based chapter in effect at the top of the
page (−1 before the first chapter opening; a blank page belongs to the chapter before it).

## Page-break contract

A block starts a new page when either:

1. its **node attribute** `breakBefore` is `'page'` or `'recto'` (the chapter / page-break ticket's
   nodes declare it), or
2. its **top-level DOM element** has the attribute `data-break-before="page" | "recto"` (style
   definitions emit it, e.g. through node decorations, without changing the document).

The node attribute wins when both are set; other values are ignored. `'page'` starts the next page;
`'recto'` starts the next recto, leaving a blank verso when the block would otherwise start on a verso.
A break before the first block of the document is a no-op. Applies to top-level blocks. The engine
reads the DOM attribute on every pass; a decoration that adds or removes it without a document change
must call `relayoutPagination()` (the styles ticket's decorations are followed through `book.styles`).

## Extension points

All exported from `@/features/pagination`; every `register*` returns its unregister function.

### (a) Header and footer slots

```ts
registerPageSlot({
  id: 'running-head',
  region: 'header',            // or 'footer'
  order: 0,                    // lower first within a region
  render: ({ page, pageCount, geometry, width, height }) => <RunningHead page={page} />,
})
```

`render` is called for every rendered page (blank ones too: check `page.isBlank`). Its region is the
text-block width wide and the top (bottom) margin tall, aligned with the text block, so it mirrors
with the margins. Slots render in the paper layer behind the text: display only, not interactive.
Frames are virtualised: slots run only for pages near the viewport.

### (b) Bottom reservations

```ts
registerBottomReservation('footnotes', (page) => footnoteHeightFor(page.from, page.to)) // px
```

While a page is filled the engine asks for the space to keep free at its bottom, with the candidate
range `{ index, side, from, to }`; the page is refilled with the (summed) reservation and asked again.
Convergence: the reservation for a page only ever grows (an answer ≤ what is reserved ends the loop),
so it cannot oscillate; the loop is capped at `MAX_RESERVE_ITERATIONS` (8). **Fallback** when the cap
is hit: the page keeps the last (largest) reservation tried and is flagged `reserveCapped` internally;
a page always keeps at least one line. Assumes fewer lines never need more space (true for
footnotes). Registering, unregistering, or calling `relayoutPagination()` when an answer changes
without a document change re-breaks the pages from the lines already measured (nothing is
re-measured: about the cost of a keystroke, tested in extension-points.test.tsx and the e2e
reservation test).

### (c) Chapters

`PageInfo.chapterIndex` uses the editor's chapter model by default (`getChapters`, breaks ticket): a
chapter opens at a Chapter Title block (an unstyled level-1 heading is one), or at the Chapter Number
directly before it; content before the first opening is front matter (−1).
`defaultChapterOpenings(doc)` gives those positions. `setChapterPredicate((node) => boolean)`
replaces the model with a per-block predicate; `null` restores the default. Both re-break only.

### Page break node

The breaks ticket's `pageBreak` atom does not carry the break: the block after it gets
`data-break-before`. **Decision: on pages the atom takes zero height.** It is the end of the page it
closes, so it must not take a line there (that line could push the page's last text line to the next
page, or leave a page holding only the break). It stays in the document and keeps its position
(selectable, deletable with Backspace); on pages it is drawn as a dashed hairline with its label just
below the last line, in the bottom margin, outside layout. Known limitation: with zero height it cannot
be selected with the mouse, only with the keyboard (Backspace after it selects it, a second one
deletes it).

### Invalidation

- `relayoutPagination()`: re-break the pages on the next frame from the measured lines (reservation
  answers, `data-break-before` decorations, a new chapter predicate). Cheap.
- `invalidatePagination()`: re-measure every block and reflow (metrics changed without a document or
  `book.styles` change, e.g. a style sheet injected by other code). About a trim change's cost.

## View, zoom and keys

- **Spread** by default; **single page** when `book.view === 'single'` or when two pages would be
  narrower than 75 % of their size in the window (`MIN_READABLE_SPREAD_SCALE`). Page breaks never
  depend on the view or the zoom.
- **Zoom** (status bar): Fit spread (default; the whole spread fits the window), Fit width, and 50 %
  to 200 % steps; zoom out / in step through the presets. A CSS transform, so zoom never changes
  line breaking.
- **PageUp / PageDown** move the caret to the first page of the previous / next spread and scroll that
  spread to the top (Shift extends the selection).
- **Status bar**: "Pages 12–13 of 384" ("Page 1 of 384" for a single page).
- **Paper**: page frames use the paper surfaces contract classes (`.nv-page`, `.nv-page--verso` /
  `--recto` in a spread, `.nv-page-muted` for slots; tokens on `<html data-surface>`); the slice adds
  geometry only. The page surface sets `--nv-pt` to 96/72 px (one point at 100 %), for style sizes.
- **Geometry**: `resolvePageGeometry(trimSize, margins)` (`geometry.ts`) wraps the book settings
  catalog's `pageBox` (96 px per inch, margins in points x 96/72).

## Tests and fixtures

- Unit (Vitest): `breaker.test.ts` (fill, widows/orphans, keep-with-next, forced breaks, blank
  versos, reservations and their cap), `placement.test.ts` (geometry, mirrored margins, spread rows,
  narrow fallback, zoom), `extension-points.test.tsx` (slots, reservations, chapters, the
  `breakBefore` contract with a fixture node).
- E2E (`e2e/pagination.spec.ts`, chromium + webkit): spread flow of a pasted 100k-word manuscript with
  split paragraphs; typing, selection, undo and find across pages; Replace and Replace All on a later
  page; IME composition in a split paragraph (Chromium, CDP `Input.imeSetComposition`: no pass while
  composing); PageUp/PageDown incl. the first and last spread; ArrowUp/Down across a split;
  `breakBefore` page / recto; narrow fallback and the spread toggle; zoom; trim reflow, mirrored margins
  and bottom reservations (re-break without re-measuring); presses on margins.
- Guard (`pm-internals.test.ts`): fails if the prosemirror-view internals the engine uses disappear
  (prosemirror-view is pinned with `pnpm.overrides`).
- Perf (`e2e/pagination-perf.spec.ts`, serial perf projects): trim reflow and typing latency.
- Cross-engine fixture (`e2e/pagination-fixture.spec.ts`): the deterministic manuscript
  (`e2e/fixtures/pagination-manuscript.ts`) typeset in the bundled OFL test font (`e2e/fixtures/fonts`,
  Libre Baskerville, `OFL.txt`), with chapters breaking in `page` mode and in `recto` mode, for every
  catalog trim size. It writes total pages and chapter opening page indexes to
  `perf-results/pagination-fixture-<browser>-<platform>.json` for the acceptance comparison. Logged
  tolerance (Vibeless decision): total pages differ by at most max(2, 1 %); chapter openings differ by
  at most 1 in `page` mode and at most 2 in `recto` mode (a one-page drift moves a right-hand opening
  by two).
