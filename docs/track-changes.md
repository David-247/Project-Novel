# Track changes (Phase 3)

The `track-changes` slice (`src/features/track-changes/`, public interface `index.ts`) records edits as
tracked changes, shows them in four markup views, and holds the pure accept / reject core. Names and the
view rules every slice needs (mark names, `MarkupView`, `isInlineHidden`, `isBlockHidden`) are in
`src/shared/track-changes.ts`. The review UI (Review menu commands, the change popover, the status-bar
count) is described under [Review](#review). Export of revision marks and collaboration are out of scope.

- [Model](#model)
- [Recording](#recording)
- [Markup views](#markup-views)
- [Accept and reject](#accept-and-reject)
- [Review](#review)
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
later steps are mapped over the deleted text kept so far. A Replace All of 16 or more matches
(`BATCH_MIN_STEPS` in record.ts) is recorded in one pass over the original document, grouped by
textblock: each match becomes one ReplaceStep covering only the match (its text, marked deleted, then
the replacement, marked inserted), so positions outside the matches (a comment draft, decorations)
map exactly. Matches that touch, a match over anything but text, or an IME composition fall back to
the step-by-step rewrite, as does the whole edit if a batched step cannot be applied. The result is the
same either way (record.test.ts compares them). The selection is mapped onto the result:
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
composition (only a transaction carrying the same `composition` meta; an unrelated one, such as a
click, never takes the mark), or else in a transaction of its own after `compositionend`
(`flushComposedText`) carrying that meta, so the history keeps it in the composition's undo step. The
footnote editor forwards its compositions the same way: its steps carry `COMPOSING_META` while the note
is composing and the note's composition id; it calls `flushComposedText` on the note's
`compositionend`, and while composing it mirrors the manuscript back only for text differences, never
for marks alone. Closing the note mid-composition (Escape, Done, blur) flushes first
(`flushComposedText(view, { force: true })`). Pending text is kept per composition id and each
composition is marked in its own transaction, so leftovers never join a later composition's undo step;
if Track Changes was turned off before the composition ended, the text stays unmarked.

**Footnote text.** The footnote editor forwards its steps into the manuscript transaction
(`StepMap.offset`), so they go through the same dispatch hook: edits inside a note are recorded like
body text, and the note editor shows the result. Backspace / Delete in the note go past deleted text
first (`skipDeleted`, as in the manuscript), and the note is mirrored back from the manuscript whenever
the two differ after a forwarded edit (deleting already-deleted text changes nothing there).

**Author.** `TrackChanges.configure({ getAuthor })`: `() => ({ name, color? })`, default
`currentTrackAuthor()`: the source set with `setTrackChangesAuthorSource` (the composition root wires the
Settings author), else "Unknown author" (no source, an empty name, or a source that throws).

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
- `acceptChangesInRange(state, from, to)`, `rejectChangesInRange(state, from, to)`: as Word does,
  **only the selected part** of each inline change (insertion, deletion, format change) is resolved:
  the text is split at the range's ends and the rest stays pending with the same id, author and date.
  Plain text between two pieces of one change does not count as touching it. A **paragraph mark** (the
  boundary of a split or join: `trackedInsert` / `trackedDelete` on a textblock) is resolved only when
  the range includes the boundary itself, as in Word, where the mark ends the previous paragraph: the
  range starts at or before the block's position and goes past it (`from <= pos && to > pos`). A
  selection starting at the block's first letter, or covering just that whole paragraph, does not
  include it (a whole-paragraph selection includes the next block's mark instead, when it reaches into
  it); a letter selected in an inserted paragraph rejects that letter, not the break before it. The
  first block of the document has no paragraph before it: its mark is resolved only by a caret, Next
  Change, Select All (an AllSelection from 0) or Accept / Reject All. A footnote reference (an atom), a break (a leaf block) and a paragraph
  style change are resolved **whole** whenever the range touches them. An empty range (a caret)
  resolves, whole, every change the caret is on: the marks beside it, an adjacent break and the blocks
  holding it (not a change whose pieces merely lie on both sides of plain text).
- `acceptAllByAuthor(state, author)`, `rejectAllByAuthor(state, author)`: every change by that author.
- `listChanges(doc)` → `{ id, kinds, author, date, from, to }[]` in document order (it skips blocks
  without changes, cached per node); `countChanges(state)`; `listAuthors(changes)`.
- `changeIdAt(doc, pos)`: the change at a caret: the text after it, then before it (the innermost mark
  when changes overlap), then a break beside it, then the boundary or style of the block holding it.

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

## Review

`review-actions.ts`, `popover-actions.ts`, `ReviewUI.tsx`, registered by `registerTrackChangesCommands`.
Each accept / reject is one transaction (`TRACK_SKIP_META`): one undo step, never recorded, even with
tracking on.

| Review menu | Shortcut | Does |
|---|---|---|
| Previous Change / Next Change | Mod-Alt-↑ / Mod-Alt-↓ | Selects the change before / after the selection (wraps) and scrolls its page into the middle of the editor region. Inline changes: their text is selected; a break: the break (node selection); a boundary or style change: the caret at the block's start. |
| Show Change Details | Alt-Enter | The change popover for the change at the caret, with the focus on Accept (All / Simple Markup). |
| Accept Change / Reject Change | | The change Next Change selected (whole), else the change at a collapsed caret (`changeIdAt`, whole), else the selected part of every change in the selection (`acceptChangesInRange`). |
| Accept and Move to Next / Reject and Move to Next | Mod-Alt-a / Mod-Alt-r | The same, then Next Change. |
| Accept All Changes / Reject All Changes | | Every change. More than 50 (`CONFIRM_ABOVE`) asks first with the app's native message dialog (`setReviewConfirm`, wired to storage's `askConfirm`). |
| Accept All by Author ▸ / Reject All by Author ▸ | | One item per author present (re-registered when the authors change), id `review.acceptAll.author.<name, URI-encoded>`: a stale native-menu item resolves that author's changes, or nothing once there are none. |

Guards: navigation `none`; Accept / Reject at the caret and Show Change Details `manuscript`; All and By
Author `modal`. Alt-Enter is also bound in the manuscript keymap (ProseMirror prevents the default of
every Enter, so the window dispatcher never sees it there). Mod-Alt-Enter (asked for in the brief) is Insert
Scene Break. The registry holds one shortcut per command, so there is no Mod-Alt-PageUp / PageDown
alternative for Previous / Next Change (in case an OS screen-rotation hotkey takes Mod-Alt-arrows);
they stay in the Review menu. Enabled state reads the current document (`hasTrackedChanges`, cached per
node), never the debounced count, so Accept and Mod-Alt-a / r work right after an edit or an undo.

**The manuscript only.** The review acts on one view: the one the composition root names with
`setReviewViewSource(() => getEditor()?.view)` (without a source, the last mounted view with the
extension, for isolated tests). Another editor built with TrackChanges (the re-write view) never takes
the commands, the popover, Alt-Enter or the count; `TrackChanges.configure({ review: false })` leaves
the review side out of such an editor entirely.

**Change popover** (`ChangePopover`, portalled): author, relative date, kind ("Inserted", "Deleted",
"Replaced", "New paragraph", "Joined paragraphs", "Inserted page break", "Formatted", "Paragraph
formatting changed") and a preview, with Accept and Reject. Opens on a click or tap on a change in All or
Simple Markup (ProseMirror's `handleClick`, which never fires after a drag-selection: the innermost
tracked span under the pointer, or a changed block clicked outside its text), or with Show Change Details.
Placed with the footnote editor's placement (`placeAnchored`, `@/shared/ui`). Tab cycles its buttons;
Escape returns to the text. It closes on any document change (typing, undo, a document load, also with
the focus in it), when the caret leaves the change, when the focus goes elsewhere (a menu), or when the
view changes to No Markup / Original. While it is closed nothing is computed for it per keystroke.

**Status bar** (`ChangesIndicator`, next to `TrackChangesNotice`): "N changes" while tracking is on or
changes exist (recounted 200 ms after edits pause); a button that runs Next Change. In a narrow status
bar (below 640px, the `statusbar` container query) it shows just the number ("12"; its name and tooltip keep
the full text) and "No changes" hides.

**Ribbon** (Review > Changes): Previous Change, Next Change, then Accept ▾ and Reject ▾ split buttons (the
main half is Accept / Reject Change; the arrow lists and Move to Next, All Changes and All by Author ▸).
See docs/design.md, "Ribbon".

**Page navigation.** The default reveal is the pagination slice's `revealPosition`: in Book mode (the
default navigation) it turns to the spread where the change is painted, in continuous scroll it centres
the change in the window; with no paginated view mounted it scrolls the nearest scroller.
`setChangeRevealer(fn)` swaps it.

Perf (`e2e/perf.spec.ts`, 100k words, 2,000 changes, local Windows 11): Accept All 230 ms / Reject All
218 ms in Chromium, 357 / 480 ms in WebKit, from the confirmation to the repaginated pages in view
(< 2 s).

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
| Replace All of 10,000 "the", tracking on (< 2 s) | 0.8–1.1 s (CI: 0.9–1.2 s) | 1.3–1.5 s (CI: 1.3–1.9 s) |

A tracked replacement is one step per match (see above), built without resolving positions per match.
It still costs about three times an untracked one: every match adds two mark elements (deleted and
inserted text), which ProseMirror draws and the browser styles. Pagination measures with one shared
Range: every Range a page creates stays live until garbage collected and is updated on each DOM
change, so creating one per measured block made each later DOM change cost O(blocks).

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
`review.markup.all|simple|none|original`). Menus (command registry, `registerTrackChangesCommands`):
Review > Track Changes (check, Mod-Shift-e) and View > Markup > All Markup / Simple Markup / No Markup /
Original (radio checks; View only, as the registry places a command in one menu). Align center moved from
Mod-Shift-e to Mod-e (as in Word). The author of new changes is the Settings author
(`setTrackChangesAuthorSource`; "Unknown author" without a name). Switching recording on with no name
known asks the one-time name question (`setOnTrackingSwitchedOn`); the recorder does not wait for it.
Comment marks and comment thread steps are never recorded as changes.

## Tests

- Review: `review-ui.test.tsx` (accept / reject per kind, nested and adjacent changes, splits, joins,
  footnotes, breaks, by author; the commands' undo steps; Next / Previous; the confirmation; the
  popover and the status count); e2e `e2e/track-changes-review.spec.ts` (chromium + webkit).
- Vitest: `record.test.ts` (typing, own and others' insertions, sessions, Backspace / Delete, deleting
  own insertions, cross-change deletes, paste, Replace All, IME, split / join, whole paragraphs, footnote
  insert / delete and edits inside a note, page breaks, bold, paragraph style and alignment, undo),
  `review.test.ts` (accept / reject all, by id, by range; what each view hides; the view switch; copy),
  `persistence.test.tsx` (book.json, manuscript.json round trip, Phase 1 / 2 documents unchanged),
  `editor/find/search.test.ts` (find per view).
- e2e (chromium + webkit): `e2e/track-changes.spec.ts` (recording, IME, views, footnote numbers and
  Find per view, persistence, page equality); perf in `e2e/perf.spec.ts`.
