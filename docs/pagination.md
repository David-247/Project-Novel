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
- Native vertical caret movement (ArrowUp/Down) across a page boundary inside one paragraph follows
  the layout column; it reaches the right line but its x position may snap to the line start.
- Off-screen cost is bounded: unchanged blocks are never re-measured (cache keyed by node identity),
  page frames are virtualised to the rows near the viewport, and the browser lays out only changed
  blocks. `content-visibility` was not needed to meet the budget (see the perf numbers below) and is
  left out: it would make measurement of skipped blocks expensive on a trim change.

### Measured in the app

`CI=1 pnpm exec playwright test e2e/pagination-perf.spec.ts --project=perf-chromium --project=perf-webkit --no-deps --workers=1`
(deterministic 100k-word, 30-chapter fixture, real app with ProseMirror, project opened from disk):

| Measure (budget) | chromium | webkit |
|---|---|---|
| Trim reflow, worst of 6 × 9 / 5 × 8 / A5 / 5.5 × 8.5 (< 1000 ms) | 184 ms | 365 ms |
| Typing at a line end mid-manuscript, median / p95 (< 50 ms median) | 14.4 / 26.4 ms | 43 / 55 ms |
| Typing inside a paragraph split across two pages, median / p95 | 20.3 / 56.6 ms | 37 / 50 ms |
| Phase 1 `perf.spec.ts` typing (now paginated), median / p95 | 13 / 25.3 ms | 34 / 47 ms |
| Phase 1 hot path (find on "the" + autosave), median / p95 | 18 / 25.7 ms | 42 / 58 ms |

420 pages at 5.5 × 8.5 in. A keystroke's pass costs about 2.5 ms (one block measured, two element
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
   boxes, in "stream px" (unscaled, page offsets subtracted). Cached by node identity.
2. **Break** (`breaker.ts`, pure, unit-tested). Fill lines while `bottom − top of page ≤ text
   height`; forced breaks; widows / orphans 2; keep headings with the next block; bottom
   reservations; at least one line per page.
3. **Place and decorate** (`placement.ts`). Page offsets from the spread / single placement;
   decorations rebuilt only when a block's offsets or split positions changed (per-block
   signatures), otherwise ProseMirror's mapping keeps them right.
4. **Publish** the page model to the store.

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
must call `invalidatePagination()`.

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
footnotes). Call `invalidatePagination()` when an answer changes without a document change.

### (c) Chapters

`setChapterPredicate((node) => boolean)` decides which top-level blocks open a chapter (default: a
level-1 heading); `null` restores the default.

### Invalidation

`invalidatePagination()`: re-measure everything and reflow on the next frame (style sheet changes,
`data-break-before` decorations, reservation answers).

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
- **Paper**: page elements use only `--page-bg`, `--page-fg`, `--page-shadow`, `--desk-bg`,
  `--spine-shadow`, each with a neutral fallback (white page, soft shadow, transparent desk). The paper
  surfaces ticket defines them in `src/shared/theme`.
- **Geometry**: `resolvePageGeometry(trimSize, margins)` (`geometry.ts`) is the single function that
  turns book settings into px (96 px per inch, margins in points × 96/72). It is a temporary local
  adapter until the book settings ticket's `pageBox` lands; swap it there.

## Tests and fixtures

- Unit (Vitest): `breaker.test.ts` (fill, widows/orphans, keep-with-next, forced breaks, blank
  versos, reservations and their cap), `placement.test.ts` (geometry, mirrored margins, spread rows,
  narrow fallback, zoom), `extension-points.test.tsx` (slots, reservations, chapters, the
  `breakBefore` contract with a fixture node).
- E2E (`e2e/pagination.spec.ts`, chromium + webkit): spread flow of a pasted 100k-word manuscript with
  split paragraphs; typing, selection, undo and find across pages; PageUp/PageDown; `breakBefore`
  page / recto; narrow fallback and the spread toggle; zoom; trim reflow, mirrored margins and bottom
  reservations; presses on margins.
- Perf (`e2e/pagination-perf.spec.ts`, serial perf projects): trim reflow and typing latency.
- Cross-engine fixture (`e2e/pagination-fixture.spec.ts`): the deterministic manuscript
  (`e2e/fixtures/pagination-manuscript.ts`) in the bundled OFL font (`e2e/fixtures/fonts`, Libre
  Baskerville, `OFL.txt`) for every catalog trim size; writes total pages and chapter opening page
  indexes to `perf-results/pagination-fixture-<browser>-<platform>.json` for the acceptance
  comparison (tolerance: total ≤ max(2, 1 %), openings ± 1).
