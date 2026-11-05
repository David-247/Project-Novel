# Track changes (Phase 3)

The `track-changes` slice (`src/features/track-changes/`, public interface `index.ts`) records edits as
tracked changes, shows them in four markup views, and holds the pure accept / reject core. Names and the
view rules every slice needs (mark names, `MarkupView`, `isInlineHidden`, `isBlockHidden`) are in
`src/shared/track-changes.ts`. The review UI (accept / reject buttons, the change list) is the next ticket;
it builds on the core described here. Export of revision marks and collaboration are out of scope.

- [Model](#model)
- [Recording](#recording)
- [Markup views](#markup-views)
- [Accept and reject](#accept-and-reject)
- [Pagination](#pagination)
- [Other features](#other-features)
- [Commands and controls](#commands-and-controls)
- [Tests](#tests)

## Model

All additive: Phase 1 and 2 manuscripts carry none of this and load and save unchanged. Every change
has `id`, `author`, `date` (ISO 8601) and, on insertions and deletions, an optional `authorColor`
(`#rgb` / `#rrggbb`; other values are ignored).

**Inline marks** (on text, hard breaks and footnote references):

| Mark | Meaning | `inclusive` |
|---|---|---|
| `insertion` | The text was inserted. | false |
| `deletion` | The text was deleted. It stays in the document until the deletion is accepted. | false |
| `formatChange` | The formatting changed; `before` holds the earlier formatting marks (JSON, e.g. `[{"type":"italic"}]`). | false |

All three set `excludes: ''`, so they overlap each other and the comments ticket's `comment` mark: text
inserted by one author and deleted by another carries both marks. A deleted footnote carries the
`deletion` mark on the footnote node itself (its note text is left as it is).

**Block attributes** (on `paragraph`, `heading`, `pageBreak`, `sceneBreak`; `null` when unused and then
left out of manuscript.json):

| Attribute | Meaning |
|---|---|
| `trackedInsert {id, author, authorColor?, date}` | The boundary before this block was inserted: a paragraph split (Enter), a pasted or new paragraph, an inserted break. |
| `trackedDelete {…}` | The boundary before this block was deleted: a paragraph join (Backspace at its start, Delete at the end of the block before), a deleted paragraph, a deleted break. |
| `trackedStyleChange {id, author, date, beforeStyleId, beforeType, beforeAttrs}` | The block's style or paragraph formatting changed (style, heading level, alignment, spacing, indents). `beforeType` / `beforeAttrs` restore it. |

A block-level change is about the boundary *before* the block, the way Word tracks the paragraph mark:

- Enter in the middle of "abcd" gives "ab" and "cd", the second with `trackedInsert`. Rejecting it joins
  "cd" back to "ab".
- Backspace at the start of "cd" (after "ab") gives `trackedDelete` on "cd": the two paragraphs stay apart
  until the deletion is accepted, which joins them.
- Deleting a whole paragraph (its text and the boundary before it) gives `trackedDelete` and a `deletion`
  mark on all its text. Accepting removes it.
- A break (page break, scene break) is a block of its own: inserted ones carry `trackedInsert`, deleted ones
  `trackedDelete`.

## Recording

While the book setting `trackChanges` is on (book.json, see docs/project-format.md), the extension's
dispatch hook (Tiptap `dispatchTransaction`) replaces each user transaction with its tracked form,
`trackTransaction(state, tr, author)` (`record.ts`, pure). The tracked form is built on the same state
and replaces the original before it is applied, so one user edit stays one transaction and one undo
step, and undo restores text and marks together. Not rewritten: undo / redo (`history$` meta), document
loads (`setDocJSON` replaces the state without a transaction), transactions with
`addToHistory: false`, accept / reject (`TRACK_SKIP_META`), and transactions that do not change the
document. Turning tracking off stops recording and keeps the existing marks.

Rules, per step of the transaction:

1. **Replace** (typing, paste, drop, Replace and Replace All, IME composition, input rules, deleting):
   - In the deleted range, text and inline nodes get a `deletion` mark; a footnote fully inside the range
     gets it on its node. Text already deleted is left as it is. **Your own insertion** (an `insertion`
     mark with your author name) **is really removed**. A block whose opening lies in the range gets
     `trackedDelete`, or, when its `trackedInsert` is your own, the boundary is really removed (joined).
   - The inserted content is cleaned of tracking marks and attributes, inserted **after** the kept deleted
     text, and gets an `insertion` mark; every block it opens gets `trackedInsert`.
   - New text next to your own change of this session takes the same mark (same id and date): typing
     extends your insertion, repeated Backspace extends your deletion. Typing next to another author's
     change, or an earlier session's, starts a new change (`inclusive: false`). Typing at the start of a
     paragraph you just inserted joins its change.
2. **Mark steps** (bold, italic, underline, fonts…): each run gets a `formatChange` holding its earlier
   marks; a run that already has one keeps it, and loses it when its formatting is back to `before`.
   Formatting your own insertion, or deleted text, is not a change of its own. Comment marks are never
   tracked.
3. **Block attribute changes** (setNodeMarkup, and AttrStep, which is converted to setNodeMarkup so the
   styles plugin sees it): the first change records `trackedStyleChange` with the earlier type and
   attributes; changing back clears it. Not recorded on a block you inserted yourself.
4. **Other steps** (wrapping in or lifting out of a list) are applied untracked.

Steps are processed in order. When every step is a replace below the previous one (one step, or Replace
All, which works from the last match to the first) every position is valid as it stands; otherwise
later steps are mapped over the deleted text kept so far. The selection is mapped onto the result:
**Backspace** leaves the caret before the text it marked, **Delete** and typing after it.
**Backspace / Delete across a deletion:** when the character (or paragraph boundary) next to the caret
is already deleted, the caret first moves over the deleted run and the key acts on the text beyond it.
If the rewrite throws, the edit is applied untracked (never a lost keystroke), the error is logged
and the status bar shows a warning (`TrackChangesNotice`, store `trackChanges.notice`) until Track
Changes is turned off or on again.

**IME composition.** While the view is composing, the composed text is inserted **without** its
insertion mark: wrapping the composing text node in a mark span mid-composition cancels or doubles the
composition in Safari. The extension keeps the unmarked ranges (mapped through every transaction) and
counts them as your own insertion, so each composition update really replaces the previous one. When
the composition ends, the ranges get their insertion mark: in ProseMirror's last transaction of the
composition, or (when there is none) in a transaction on `compositionend` carrying the same
`composition` meta, so the history keeps it in the composition's undo step.

**Footnote text.** The footnote editor forwards its steps into the manuscript transaction
(`StepMap.offset`), so they go through the same dispatch hook: edits inside a note are recorded like
body text, and the note editor shows the result. Backspace / Delete in the note go past deleted text
first (`skipDeleted`, as in the manuscript), and the note is mirrored back from the manuscript whenever
the two differ after a forwarded edit (deleting already-deleted text changes nothing there).

**Author.** `TrackChanges.configure({ getAuthor })`: `() => ({ name, color? })`, default
`() => ({ name: 'Author' })`. The composition root wires it to the settings at integration.

## Markup views

View ▸ Markup (store `trackChanges.markupView`, UI state, not saved with the project). The view is the
attribute `<html data-nv-markup>`, so the manuscript, the footnote area and the footnote editor follow it.

| View | Shows |
|---|---|
| All Markup (`all`, default) | Insertions underlined and deletions struck through in the author's colour (or the paper's tracking colour); formatting changes with a dotted rule; a bar in the margin beside the first line of a block whose boundary or style changed. |
| Simple Markup (`simple`) | The final text, and a change bar in the margin beside changed lines. |
| No Markup (`none`) | The final text only. |
| Original (`original`) | The text before the changes: deletions as normal text, insertions hidden. |

Text keeps the page's colour in every view (contrast unchanged); the underline, strike and bars are
non-text graphics with at least 3:1 against each paper (`--page-tc-*` tokens per surface).

**Hiding.** An inline node the view hides (`isInlineHidden`) is `display: none` (its mark's span). A block
the view hides entirely (`isBlockHidden`: a `trackedDelete` block whose content is all deleted, in
Simple / No Markup; a `trackedInsert` block whose content is all inserted, and inserted breaks, in
Original) gets a node decoration (`nv-tc-gone-final` / `nv-tc-gone-original`) that collapses it to zero
height with everything inside it `display: none`. It is exactly what accepting (rejecting) all would
remove.

**Known limitation.** A pending paragraph join (`trackedDelete` on a paragraph that keeps visible text) and
a pending split whose second half holds original text stay two paragraphs in No Markup and Original until
the change is accepted or rejected: a single editable view cannot show two blocks as one.

**Copy.** A copy, cut or drag takes the final text in All, Simple and No Markup (deleted text left out,
no tracking marks or attributes), as Word does; in Original it takes the original text. Pasted content
loses any tracking marks and, while tracking is on, is recorded as an insertion.

## Accept and reject

`review.ts`, pure: each function returns a transaction on the state (one undo step, never recorded as a
change) or `null` when there is nothing to do.

- `acceptChange(state, id)`, `rejectChange(state, id)`: every mark and block attribute with that id.
- `acceptAll(state)`, `rejectAll(state)`.
- `acceptChangesInRange(state, from, to)`, `rejectChangesInRange(state, from, to)`: every change whose
  marks or blocks touch the range (or contain `from` when the range is empty).
- `listChanges(doc)` → `{ id, kinds, author, date, from, to }[]` in document order; `countChanges(state)`.

| | Accept | Reject |
|---|---|---|
| `insertion` | mark removed | text removed |
| `deletion` | text removed | mark removed |
| `formatChange` | mark removed | `before` marks restored, then the mark removed |
| `trackedInsert` | attribute cleared | boundary removed |
| `trackedDelete` | boundary removed | attribute cleared |
| `trackedStyleChange` | attribute cleared | `beforeType` / `beforeAttrs` restored |

Inline changes are resolved first (marks, then removed text from last to first), then blocks: first
attributes and the blocks that go away whole (breaks, empty blocks), last to first; then the joins.
The order matters for a break inserted mid-paragraph (Mod-Enter in "abcd" gives `ab | +¶[pageBreak] |
+¶cd`): the break goes before "cd" can join "ab", so rejecting gives "abcd" back. **Removing a boundary:** a break is deleted; an empty block is deleted (unless it is its
parent's only child); otherwise the block is joined to the textblock before it when they can join, and
left as it is when they cannot (the first block, after a list).

## Pagination

The engine measures rendered line boxes (docs/pagination.md), so hidden text must take no space and no
line: inline marks use `display: none`, hidden blocks have no height and no laid-out content (text
directly inside a hidden break gets `font-size: 0`), leaving one zero-height line the breaker ignores.
Nothing visible changes width between views, so a view's page breaks equal those of the manuscript with
all changes accepted (No Markup, Simple Markup) or rejected (Original): checked by
`e2e/track-changes.spec.ts` on a fixture with inserted and deleted words and paragraphs (page count,
chapter of every page and the text at the top of every page).

**A view switch** sets the attribute, dispatches a decoration-only transaction with meta
`MARKUP_VIEW_META` (footnote numbers, `data-break-before`, find recompute on it), and calls the
repaginate hook with the positions of the top-level blocks holding changes; the composition root sets it
to `invalidatePaginationAt` (`setMarkupViewRepaginate`). Those blocks are re-measured and the book
reflows: the trim-reflow budget (< 1 s to reflow complete).

- **Breaks.** A block or page break the view hides is skipped by the styles plugin's `data-break-before`
  (a deleted chapter title starts no page in No Markup, an inserted page break none in Original).
- **Chapters and running heads.** `getChapters` follows the current view (a hidden title opens no chapter;
  titles leave out hidden text); `blockPlainText(node, { markupView })` is the view-aware block text.
- **Footnotes.** `collectFootnotes` leaves out notes the view hides: a deleted note takes no number and no
  space in No Markup. Note measurements are dropped on a switch (hidden text inside notes).

Outside All Markup the `data-break-before` decorations are mapped on typing, like in All Markup, and
recomputed only when an edited block became hidden or visible.

Perf (`e2e/perf.spec.ts`, 100k words, 2,000 changes, local Windows 11, a loaded host; Windows WebKit is
not a shipping pair):

| Measure (budget) | Chromium | WebKit |
|---|---|---|
| Typing, tracking on, All / No / Simple Markup (< 50 ms median) | 18 / 20 / 20 ms | 43 / 48 / 51 ms |
| View switch, reflow complete, worst of three (< 1 s) | 290–370 ms | 665–750 ms (up to 1.45 s) |
| Replace All of 10,000 "the", tracking on (< 2 s) | 0.9–1.1 s | 1.5–2.4 s |

A tracked replacement is two steps (the deletion mark, then the new text inserted with its insertion
mark), so a tracked Replace All costs about twice an untracked one.

## Other features

- **Find** skips hidden text in Simple / No Markup (deleted) and Original (inserted); All Markup finds
  everything. Replace never replaces a match that is all deleted text: Replace goes on to the next match
  still there, Replace All counts only what it replaced (and its summary shows until the document
  changes, since All Markup still finds the deleted originals). Replacement text never inherits
  tracking marks.
- **Word count**: none exists yet; when it does, it should count `isInlineHidden(node, 'none')`-visible text.
- **Storage**: the marks and attributes are ordinary manuscript.json content: save, reopen and crash
  recovery keep them. `trackChanges` is in book.json.

## Commands and controls

From `@/features/track-changes`: `toggleTrackChanges(editor?)`, `setTracking(on)`, `isTracking(state?)`,
`setMarkupView(view)`, `getMarkupView(state?)`. Toolbar Review group: Track Changes toggle
(`review.track`, Mod-Shift-e, pressed while recording) and the Markup picker (`review.markup`, items
`review.markup.all|simple|none|original`). The command registry and menus are wired by the composition
root. Align center moved from Mod-Shift-e to Mod-e (as in Word).

## Tests

- Vitest: `record.test.ts` (typing, own and others' insertions, sessions, Backspace / Delete, deleting
  own insertions, cross-change deletes, paste, Replace All, IME, split / join, whole paragraphs, footnote
  insert / delete and edits inside a note, page breaks, bold, paragraph style and alignment, undo),
  `review.test.ts` (accept / reject all, by id, by range; what each view hides; the view switch; copy),
  `persistence.test.tsx` (book.json, manuscript.json round trip, Phase 1 / 2 documents unchanged),
  `editor/find/search.test.ts` (find per view).
- e2e (chromium + webkit): `e2e/track-changes.spec.ts` (recording, IME, views, footnote numbers and
  Find per view, persistence, page equality); perf in `e2e/perf.spec.ts`.
