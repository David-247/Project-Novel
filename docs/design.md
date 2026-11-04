# Design system (Phase 1)

Audience: hobbyist novelists. The app should feel calm, focused and writerly: the manuscript is the
brightest, quietest plane on screen and everything else steps back.

## Direction

- **Three planes.** Chrome (toolbar, status bar) sits on `bg`, a cool grey-blue. The writing surface is
  `surface`, a near-white (light) or soft charcoal (dark). Panels, dialogs and inputs float on
  `surface-raised`. Hierarchy comes from these tone steps and thin `border` hairlines, not from heavy shadows.
- **One accent: slate-teal ink.** It's a bottle-ink blue-green (`#1d5c68` light, `#7cc3ce` dark). It is
  used only for the primary action, pressed toggles, checked boxes, links and the focus ring, so the
  colour always means "active" or "the thing to do". We avoided warm cream with terracotta, and we
  avoided black with an acid accent. Both are overused defaults, and neither suits long, calm sessions.
- **Type.** We only use OS fonts, because the app is fully offline and fetches nothing.
  - UI: Segoe UI Variable / Segoe UI on Windows, SF Pro on macOS, then system-ui. UI text is 12–16px.
  - Prose: Iowan Old Style or Charter on macOS, Sitka Text or Cambria on Windows, then Georgia. Prose is
    18px with a 1.7 line height. The token is defined here, but styling document content belongs to the
    editor ticket and Phase 2 surface themes.
  - Status-bar numbers use tabular figures so counts don't jitter.
- **Shape.** Controls use a 6px radius and containers use 10px. The different radii make it easy to
  tell a control from a container at a glance.
- **Motion.** There is one moment: a dialog fades and rises 4px when the user opens it. Nothing animates
  without the user doing something, and everything is disabled under `prefers-reduced-motion`.
- **Touch-tolerant.** Every control is at least 32×32 (`min-h-control min-w-control`). No action is
  hover-only. The toolbar wraps instead of overflowing, and the dialog width is `min(28rem, 100vw - 2rem)`.

## Tokens: `src/shared/theme/tokens.css` (single source)

Raw values are `--nv-*` custom properties per theme, selected by `data-theme` on `<html>`. They are
mapped to Tailwind with `@theme inline`, so utilities switch instantly when the theme changes.

| Token (CSS `--nv-*` / Tailwind) | Role |
|---|---|
| `bg` | App chrome: toolbar, status bar, window backdrop |
| `surface` | Writing surface container (editor `<main>`) |
| `surface-raised` | Panels, dialogs, menus, inputs |
| `surface-hover` | Hover/active fill for quiet controls |
| `text`, `text-muted` | Primary and secondary text |
| `accent`, `accent-hover`, `accent-contrast` | Primary action fill, its hover state, and the text on it |
| `accent-soft` | Pressed toggle fill and text selection |
| `border` | Decorative hairlines between regions |
| `border-control` | Outlines of inputs, selects, checkboxes and secondary buttons (3:1) |
| `focus-ring` | Keyboard focus outline (3:1 on every plane) |
| `danger`, `danger-hover`, `danger-contrast`, `warning`, `success` | Status text and the danger button (with its hover fill) |
| `scrim`, `shadow-raised` | Dialog overlay and raised shadow (decorative) |

Utilities: `bg-surface`, `text-text-muted`, `border-border-control`, `outline-focus-ring` and so on.

Other tokens:
- Typography: `font-sans`, `font-prose`, `font-mono`; sizes `text-ui-xs` (12), `text-ui-sm` (13),
  `text-ui` (14), `text-ui-lg` (16), `text-prose` (18).
- Radii: `rounded-control` (6px), `rounded-panel` (10px).
- Sizes (named spacing): `control` 32px, `control-lg` 40px, `toolbar` 48px, `statusbar` 32px, `gutter` 16px.
  Use them as `h-control`, `min-w-control`, `min-h-toolbar` and so on.

Color values must stay 6-digit hex: the contrast test parses this file.

## Light/dark following

`useThemeFollow()` from `@/shared/theme` is called once in `App.tsx`. It feeds the store action
`appActions.setColorScheme` from two sources:
1. the `prefers-color-scheme` media query (`useColorSchemeSync` in the store), which works in any webview;
2. in Tauri, `getCurrentWindow().theme()` and `onThemeChanged`, which need only the already granted
   `core:default` permissions. The initial `theme()` read is async. If an event or a media-query change
   lands before it resolves, the stale initial value is dropped.

A layout effect then writes `app.colorScheme` to `<html data-theme>` before paint. The theme blocks also
set `color-scheme`, so native controls and scrollbars match. Without the attribute, `:root` falls back
to light.

## Contrast (WCAG 2.1 AA)

`src/shared/theme/contrast.test.ts` checks every pair in `CONTRAST_PAIRS` (`src/shared/theme/contrast.ts`)
in both themes:
- text pairs need at least 4.5:1;
- UI pairs (control borders, focus ring, button fills) need at least 3:1.

Add a pair there whenever a new fg/bg combination is introduced, including hover states: every hover
fill is its own token (`surface-hover`, `accent-hover`, `danger-hover`). Opacity is never used for hover, so every
hover state can be tested. Disabled controls (50% opacity) are
exempt under WCAG.

## Primitives: `@/shared/ui`

These are the building blocks for the toolbar, find panel, dialogs and status bar. Each one forwards
native props and `ref` (React 19 ref-as-prop), and each has a visible focus ring.

| Component | Key props | Use |
|---|---|---|
| `Button` | `variant: 'primary' \| 'secondary' \| 'ghost' \| 'danger'` (default secondary), `size: 'md' \| 'lg'` | Text actions. Defaults to `type="button"`. One primary per view. |
| `IconButton` | `label` (required, becomes the accessible name), `children` (an SVG) | Icon-only toolbar actions |
| `ToggleButton` | `pressed`, `onPressedChange(next)`, `label?` | Bold, italic and other on/off toolbar states. Sets `aria-pressed`. Pressed shows a fill and an underline bar, so it doesn't rely on colour alone. |
| `ToolbarGroup` | `label` (required) | A `role="group"` cluster that wraps on narrow widths |
| `ToolbarSeparator` | none | A vertical `role="separator"` |
| `TextInput` | native input props | Find field, rename field. Set `aria-invalid` to get a danger border. |
| `Select` | `options: {value,label}[]`, `wrapperClassName?` (for layout on the wrapper span), plus native select props (`className` is applied to the `<select>`) | A native select with a themed chevron |
| `Checkbox` | `label`, `checked`, `onCheckedChange(next)` | Find options such as "Match case" |
| `Panel` | `label?` (makes it a labelled region) | A raised container, for example the find panel |
| `Dialog` | `open`, `onOpenChange`, `title`, `description?`, `footer?`, `closeLabel?`, `closeControlId?` | Modal built on Radix Dialog (focus trap, Esc, focus return). Put the primary action last in `footer`. |
| `DialogClose` | `asChild` | Wraps a footer button so it closes the dialog |
| `StatusText` | `tone: 'muted' \| 'default' \| 'success' \| 'warning' \| 'danger'`, `live?` | Status-bar items. `live` makes it an `aria-live="polite"` region. |
| `cn`, `focusRing`, `controlBase`, `fieldBase` | none | Class helpers for custom controls that need to match |

| `Tooltip` | one control as `children`; `controlId?` (defaults to the child's `data-control-id`), `copy?`, `side?`, `wrap?` | Hover + keyboard-focus tooltip: title, one-line description, platform shortcut hint. See below. |
| `TooltipProvider` | `lookup(controlId)`, `delayDuration?` (500), `skipDelayDuration?` (300), `platform?` | Mounted once in `App.tsx` with the tooltips registry as `lookup` |
| `formatShortcut`, `ariaKeyshortcut` | a spec such as `"Mod-b"` or `"Mod+Shift+Z"` | `⌘B` / `Ctrl+B` and `Meta+B` / `Control+B` from one spec |

### Tooltips

Every interactive control has a tooltip. Wrap it in `<Tooltip>` at the call site and give it a
`data-control-id`. The text comes from the registry in the tooltips slice
(`src/features/tooltips/registry.ts`, the one file to edit for copy). The composition root passes it to
`<TooltipProvider lookup={getTooltipCopy}>`, so `shared/ui` and the editor never import the tooltips slice.
Titles and shortcuts are taken from the editor's control metadata (`TOOLBAR_CONTROLS`,
`HISTORY_CONTROLS`, `FIND_CONTROLS`), which also supplies the accessible names, so they cannot drift apart.

- A tooltip opens on hover (500 ms, then instant while moving along the toolbar) and on keyboard focus.
  Focus counts as keyboard focus only when a key press led to it, so a dialog that auto-focuses its first
  button, or script focus after a click, does not open one. Text fields need Tab specifically, and the
  tooltip hides as soon as you type.
- Escape closes it without consuming the key, so the toolbar's Escape-to-editor and the find panel's
  Escape-to-close run on the same press. Inside a dialog the tooltip is a layer above the dialog: the
  first Escape closes only the tooltip, and the next one closes the dialog.
- `Dialog`'s close (X) button has a tooltip too. Pass `closeControlId` when `closeLabel` is not plain
  "Close"; the default id is `dialog.close`.
- The description and shortcut are always linked through `aria-describedby` (a hidden element), so
  screen readers get them without hovering. Shortcuts are also exposed as `aria-keyshortcuts`.
  On touch, a long-press (`contextmenu`) shows the tooltip. The essentials (the control's name and its
  icon) never depend on it.
- `wrap` anchors the hover area to an inline wrapper, which is used for a checkbox with its label.
- `Tooltip` forwards unknown props and `ref` to the control, so it can sit inside `ToolbarItem`.
- Visuals: `surface-raised` with a `border` hairline and `shadow-raised`, using `text` and `text-muted`.
  These pairs are already in `CONTRAST_PAIRS`.
- `src/App.tooltips.test.tsx` renders the whole app with the find panel and each recovery dialog open, and fails if any
  button, select, checkbox or text field lacks a registered, wired tooltip (`auditTooltipCoverage`).
- Native OS menu items (File > New/Open/Open Recent/Save) can't show web tooltips. Their labels and
  accelerators are the hint, and their copy is registered under the `file.*` ids for any future in-app
  equivalent.

Example toolbar:

```tsx
<ToolbarGroup label="Text formatting">
  <Tooltip>
    <ToggleButton label="Bold" data-control-id="toolbar.bold" pressed={isBold} onPressedChange={() => toggleBold()}><BoldIcon /></ToggleButton>
  </Tooltip>
</ToolbarGroup>
<ToolbarSeparator />
<Tooltip>
  <IconButton label="Find and replace" data-control-id="find.open" onClick={openFind}><SearchIcon /></IconButton>
</Tooltip>
```

## App shell

`AppShell` paints the toolbar header and status footer on `bg`, separated from the editor by a `border`
hairline. The editor `<main>` is the desk: `bg-desk text-text` (`--desk-bg` of the current paper surface).
Document content is the editor slice's job, and the page lying on the desk is described next.

## Paper surfaces (Phase 2)

The writing surface is a sheet of paper on a desk, chosen per project with `book.surface`
(`auto | book | white | dark`; the book slice owns state and persistence).

**Choices.**
- *White*: a classic word-processor page (`#ffffff`, ink `#1b1d1f`) with a crisp 1px edge and a two-layer
  shadow on a neutral grey desk (`#d6d9dd`).
- *Dark*: a charcoal page (`#202327`, text `#e7e9eb`) on a near-black desk (`#0e1012`).
- *Book*: aged cream paper (`#f4ead2`, ink `#2a2016`) on a walnut-brown desk (`#bfb29a`). The paper has
  a top-lit gradient, a faint laid-paper grain (both CSS gradients, no bitmaps), shaded inner edges, and
  a soft shadow toward the gutter of each page. In dark mode it becomes warm dark paper (`#2b2520`,
  text `#eadfc9`) on `#16120f`. Book never turns into a plain white or dark page: it has two variants.
- *Auto* (default): white when the OS is light, dark when it is dark, switching live. It reuses
  `useThemeFollow` / `app.colorScheme`.
- Why not default cream everywhere: only Book is warm. White and Dark stay neutral so a writer
  can choose between "a printed book" and "a document" on purpose.
- The picker is a segmented radio group (`book.surface`, options `book.surface.auto|book|white|dark`).
  Each option has a swatch painted with the real tokens, a miniature page or, for Book, an open spread;
  Auto is a white and dark page split on the diagonal. Labels show from the `lg` breakpoint up.

**How it is applied.** `useSurfaceFollow()` (once, in `App.tsx`) writes the resolved surface to
`<html data-surface="book|white|dark">`; `resolveSurface(surface, colorScheme)` does the Auto logic.
`src/shared/theme/surfaces.css` defines the tokens per surface (Book also reads `<html data-theme>` for its
light/dark variant). Switching changes colours, shadows and background images only: no widths,
paddings, borders or font properties, so nothing reflows.

**Token contract** (all on `<html>`; consume only these, never raw colours):

| Token | Use |
|---|---|
| `--page-bg`, `--page-fg`, `--page-muted-fg` | Page fill, body text, secondary text (page numbers, running heads) |
| `--page-selection-bg` | `::selection` on a page (text stays `--page-fg`) |
| `--page-find-bg`, `--page-find-current-bg`, `--page-find-ring` | Find matches, the current match, and its outline |
| `--page-focus-ring` | Focus outline around the page, drawn on the desk |
| `--desk-bg` | Background behind the pages (Tailwind `bg-desk`) |
| `--page-shadow`, `--page-edge` | Drop shadow and inner edge shading (box-shadow lists) |
| `--page-texture` | Background-image layers for the paper (`none` on White and Dark) |
| `--spine-shadow`, `--spine-width` | Gutter shading colour and extent (transparent / 0% except Book) |

**Class contract for page elements (pagination).**
- `.nv-page`: one rendered page. It already gets background, text colour, texture, edge shading, shadow and
  selection colours. Add no colours of your own.
- `.nv-page--verso` (left page) / `.nv-page--recto` (right page), or `.nv-page[data-page-side="verso|recto"]`:
  adds the spine gradient on the gutter side. `.page--verso` / `.page--recto` are accepted aliases.
  A single-page view omits them.
- `.nv-page-muted`: secondary text on a page.
- Find highlights use the `.nv-find-match` / `.nv-find-match-current` classes (find.css), which read the
  tokens above, so they work on any page.
- Until pagination lands, `.novel-writing-surface` (the continuous editor column) is styled as one long
  `.nv-page`.

**Contrast.** `parseSurfaceTokens` and `SURFACE_CONTRAST_PAIRS` (`src/shared/theme/contrast.ts`) check, for
each of the four token sets (white, dark, book-light, book-dark): body and muted text on the page,
`--page-fg` on selection and both find fills (4.5:1), and the find ring and focus ring (3:1). Texture
and edge shading are kept faint enough that the flat `--page-bg` ratios stay valid.

hairline. The editor `<main>` uses `bg-surface text-text`, and that is all the shell styles there:
document content is the editor slice's job, and paper/book surfaces and page spreads are Phase 2.

## Paragraph and chapter styles (Phase 2)

**Rendering.** Styles are one generated `<style>` element (`BookStyleSheet`), one rule per style keyed by
`[data-style="<id>"]` under `.novel-editor-content`. Editing a style rewrites that text only: O(number of styles),
no document transaction (measured: 40 chapters in a 100k-word manuscript restyle in ~20 ms in Chromium, ~60 ms in
WebKit). Direct formatting from the toolbar is inline style on the block or a text mark, so it always wins over the
style, as in Word; **Clear direct formatting** (Mod-\) removes it.

**Book points.** Sizes and spacing are in points, rendered as `calc(N * var(--nv-pt, 1pt))`. The continuous
writing view sets `--nv-pt` so Body (11 pt) shows at the Phase 1 reading size (18px); page surfaces set it to a
true point times their zoom.

**Built-in defaults** (book typography for an 11 pt text face): Body 11/16.5 pt, ragged right, 1.5 em indent, no
space between paragraphs (switch to Justify in Modify style for print); First Paragraph without the indent; Chapter
Number 12 pt small capitals, tracked; Chapter Title 20 pt centred with a 72 pt sink, new page; Part Title 24 pt
capitals, 144 pt sink, new right-hand page; Subheading 13 pt semibold; Scene Break centred, 12 pt above and below;
Block Quote 10 pt indented 2 em both sides; Epigraph 10 pt italic indented 4 em; Dedication italic, centred,
144 pt sink, new right-hand page. **Heading group:** a style whose `nextStyle` is another breaking style (Chapter
Number → Chapter Title) breaks once; the second block gets no break and no space before.

**Pagination contract.** Top-level blocks whose style breaks carry `data-break-before="page|recto"` (a ProseMirror
node decoration, so style edits never change the document). Every paragraph/heading carries `data-style`.

**Toolbar.** A "Styles" group after the spacing controls: the picker (a native select showing the current
paragraph's style; Mod-Alt-0 Body, Mod-Alt-1 Chapter Title), Modify style (pilcrow-and-nib icon), Manage styles
(stack of set lines) and Clear direct formatting (struck T).

**Modify style.** The one expressive element is the *proof*: a slice of manuscript on the writing plane showing
the paragraph before (muted), a dashed "New page" / "New right-hand page" rule when the style breaks, the sample
(the writer's own paragraph when opened from the toolbar) and the next paragraph in the style Enter would create.
It renders through the same resolver as the manuscript, so the preview cannot disagree with the result. The form
is grouped Style / Type / Paragraph; an empty field inherits, and its placeholder or "From <parent>" option says
what it inherits. Two columns from `md`, one column (form, then proof) on phones; the dialog widens to 48rem.

**Manage styles.** Chapter and paragraph styles in two labelled groups; each row is a pressed-state button whose
name is set in the style's own weight, slant, case and (capped) tracking, so the list reads as a specimen. Built-in
styles can be modified and duplicated but not renamed or deleted. Rename and delete confirmation appear inline
under the list (delete says how many paragraphs switch, and to which style); results are announced in a polite
live region. Colours are existing token pairs only (selected row `accent` on `accent-soft`, delete in `danger`).

## Book layout: trim size picker (Phase 2)

- The picker is a Radix dropdown menu opened from a ghost toolbar button (`book.trimSize`) in its own "Book layout" toolbar group after Find. The button shows the current size as label plus dimensions and a chevron, so the current trim size is visible without opening anything.
- The menu lists the sizes in two labelled groups, US and UK/EU, as radio items with a check mark. Each row is a label (medium weight, `text`) and its dimensions (`text-muted`); both pairs are already in `CONTRAST_PAIRS`. Rows are `min-h-control-lg` (40px) for touch, and the menu opens on press, with no hover-only behaviour.
- Keyboard: Enter, Space or ArrowDown on the button opens the menu; arrows move, Enter selects, Escape closes and returns focus to the button. The button joins the toolbar roving focus through `ToolbarItem`.
- Every row has its own `data-control-id` (`book.trimSize.<id>`), registry entry and tooltip (opened on the right), so the coverage audit also passes with the menu open.
- Changing the size also moves the margins to the new size catalog defaults, but only while the margins still equal the previous size defaults, so margins the user customised are never overwritten.

## Chapter, page and scene breaks (Phase 2)

- **breakBefore contract (docs/pagination.md did not exist yet; this section is the record).** A page break is a block atom `pageBreak` (`<div data-page-break>`); it does not carry the break itself. The block that follows it is decorated `data-break-before="page"` (`"recto"` if its own style already breaks to recto), by the same node decoration that exposes style breaks (`computeBreaks` in `styles/block-styles.ts`). Pagination therefore only reads `data-break-before` on top-level blocks, whatever its source. The page break node itself is a normal block at the end of the page it closes.
- **Chapters** are top-level blocks whose rendered style is a *chapter title style*; a block in a *chapter number style* directly before one joins its chapter. `getChapters(doc)` returns `[{ index, title, from, to }]` (the title without footnote text, `blockPlainText`); content before the first is front matter, `FRONT_MATTER_INDEX` (-1), `chapterIndexAt(chapters, pos)`.
- **The chapter rule** (`chapterRoles` in `src/shared/book/styles.ts`): a style is a chapter title style when it is a chapter style (`kind: "chapter"`) at outline level 1 whose Based on chain reaches Chapter Title (Chapter Title itself included); a chapter number style likewise reaches Chapter Number first. Why this rule: "based on Chapter Title" is what a writer already says when they make a variant (a prologue or epilogue title), it is visible and editable in Modify style, and it keeps Part Title (also a level-1 chapter style) and its variants out, so parts never restart chapter numbering or running heads. A style based on Chapter Title but made a paragraph style or a level 2-3 heading (a subtitle) is not a chapter title. **Duplicate** of a built-in is therefore based on the built-in (with all its settings copied, so it looks identical): a duplicate of Chapter Title opens chapters, a duplicate of Chapter Number joins them, a duplicate of Part Title stays a part. A duplicate of a custom style keeps its parent.
- **Everything that depends on chapters follows the style sheet**, not only the document: pagination re-breaks on a style change (its chapter openings are recomputed every pass), running heads re-read chapter titles after a style change, and per-chapter footnote numbers are recomputed when a style change changes which styles open chapters (`chapterRoleSignature`).
- **"Chapters start on"** (next page / right-hand page) is not a new book field: it rewrites `breakBefore` of Chapter Title, and of every other chapter title or chapter number style that breaks at all (a style set to no break keeps it).
- **Scene break** is a block atom `sceneBreak` with an `ornament` attribute (`* * *`, `#`, a fleuron, or blank line), rendered `data-style="scene-break"` so the Scene Break style centres it; it never breaks pages. Inserting one makes the paragraph after it First Paragraph. `***` or `###` alone on a line converts (`###` gives `#`); one undo reverts. Because of this, typing `### ` no longer creates an H3 (the rule fires at the third `#`); H3 is still available from the toolbar or the style picker.
- **Insert menu** (toolbar group "Insert", `insert.menu`): Page break, New chapter, Scene break, then radio groups "Chapters start on" and "Scene break ornament". Same Radix dropdown as the trim size picker; every row has a control id, registry entry and tooltip. New items are one entry in `INSERT_ITEMS` (`breaks/controls.ts`); the menu and registry both read it.
- **Editor look.** A page break is a dashed rule with a "Page break" label on a paper-coloured plate (`--page-muted-fg` on `--page-bg`, the existing AA pair); selected, it gets the page focus ring. No new colours.
- **Paste.** `page-break-before/after` and `break-before/after: page|always|left|right|recto|verso` become page break nodes; `<hr>` becomes a scene break. Limitation: left/right/recto/verso are not distinguished, they all become a plain page break (never a recto break). Only paste is wired (`transformPastedHTML`); an import path would call the exported `mapPastedHtml` itself.

## Footnotes (Phase 2)

- **Reference.** A small raised number (0.72 em, raised 0.45 em by relative positioning, so lines keep
  their height) in the text colour. Selected (arrow onto it), it gets the page focus ring. The press /
  tap target is a 32 × 32 px box around the mark, out of flow. Known trade-off: that box is taller than
  a line, so it overlaps the lines above and below the reference by a few pixels; a press there opens
  the note instead of placing the caret. Accepted for the touch-target minimum. A find match inside a
  note is highlighted on the reference with the find colours.
- **Footnote area.** At the bottom of the text block, in the Footnote Text style (9 pt on 11.7 pt, flush
  left), `--page-fg` on the paper: the same AA pair as body text. Each note starts with its raised mark.
  A third-width hairline rule sets the notes off; a page whose area starts with the rest of a note gets a
  full-width rule (the printer's continuation rule). The rule is decorative (75 % opacity) and can be
  turned off. When the last page cannot hold all its notes, an italic "continued…" marker, right-aligned,
  takes the area's last line for itself (the notes show one line less there), so it never covers note
  text. It is `--page-fg` on the paper, the body-text pair. No new colours.
- **Footnote editor.** An anchored popover (`surface-raised`, `border`, `shadow-raised`, the panel
  radius) under the reference, flipping above it near the window bottom: header "Footnote 3", the hint
  "Esc returns to the text" in `text-muted`, a Done button, and a field-styled editable line in the UI
  font (writing there should read as editing, not as typesetting). Escape, Enter or Done go back to the
  text after the reference. Tab cycles between the field and Done. Width min(28 rem, window − 1 rem),
  so it fits phones.
- **Accepted as they are (review):** Escape first closes an open tooltip, then a second Escape closes the
  dialog (app-wide tooltip behaviour); Footnote Text is listed in the style picker like every built-in.
- **Footnote options.** A "Footnotes" ghost text button in the Insert toolbar group opens a standard
  `Dialog`: two native selects (Numbering, Number format) and a checkbox (Separator line), each with a
  visible label and a registry tooltip; changes apply at once; Done (primary) closes, focus returns to
  the button.

## Pages and spreads (Phase 2, pagination)

The writing surface is now a desk with book pages on it (`src/features/pagination`, docs/pagination.md).

- **Paper comes from the surfaces contract.** Each page frame is an `.nv-page` with `.nv-page--verso` /
  `.nv-page--recto` in a spread (spine on the gutter side) and none in single view; header and footer
  slot regions are `.nv-page-muted`. The slice adds geometry only, no colours. The text layer above the
  frames uses `--page-fg` and `--page-selection-bg`; the desk behind the pages is `--desk-bg`.
- **Book points.** The page surface sets `--nv-pt` to a true point (96/72 px); zoom is a transform on
  top, so style sizes (`calc(N * var(--nv-pt))`) are exact at 100 % and line breaks never depend on zoom.
- **Status bar page controls** sit at the trailing end, after the project actions: the page indicator
  ("Pages 12–13 of 384", tabular figures), the spread toggle (an open-book icon, pressed = two pages),
  zoom out, the zoom select (Fit spread / Fit width / 50–200 %) and zoom in. All are standard
  `IconButton` / `ToggleButton` / `Select` controls: 32 px targets, tooltips from the registry, keyboard
  reachable in the footer's tab order, existing contrast pairs.
- **Fit spread is the default zoom**: the whole spread fits the window, like holding the book open.
  Narrow windows fall back to single pages (touch-tolerant; no hover-only actions). A press on a margin
  or the desk puts the caret on the nearest line of that page.

## Headers, footers and page numbers (Phase 2)

Slice `src/features/header-footer/`. They are drawn on the page, not written in the manuscript: through the
pagination slice's header / footer slots (`registerPageSlot`), in the top and bottom margin, behind the text layer.
They never take part in find, selection, the undo history or pagination, and the margin box is the limit: a long
running head is clipped (one line, `overflow: hidden`, ellipsis) and can never move the text block.

- **What a page shows** is decided by one pure function, `resolveHeaderFooter(page, pages, chapters, settings, meta)`
  (`src/shared/book/header-footer.ts`), used by the pages and by the dialog preview. Defaults are the trade-fiction
  convention: author on left-hand (verso) pages, book title on right-hand (recto) pages, arabic numbers centred in
  the footer starting at 1 on the first chapter; nothing on chapter-opening and blank pages; front matter (before the
  first chapter) has no running head and no number (or lower-case Roman numerals when asked). Blank pages are
  counted but show nothing.
- **Type**: the built-in **Running Head** style (9 pt, centred, based on Body). Editing the style in Manage styles
  restyles every head; margins and indents of the style are ignored (the head is a box in the margin). Colour is
  `--page-muted-fg` through `.nv-page-muted`, which meets AA on the four paper surfaces (`SURFACE_CONTRAST_PAIRS`).
- **Incremental**: each slot component selects only its own resolved strings from the store (shallow compare), the
  chapter list is re-derived when the layout is republished, and a chapter title edit (checked once per frame, only
  while a head shows chapter titles) re-renders just the heads whose text changed. No layout pass is requested.
- **Dialog "Headers & page numbers"** (toolbar button `book.headerFooter`, or a double-click on any header or footer
  region; Escape closes). Changes apply to the pages at once; there is no OK / Cancel to remember. A live mini preview
  of two spreads (chapter opening, inside the chapter) is drawn with the real resolver and the real Running Head
  style at a larger-than-true type scale so it can be read. "Book details..." opens the small dialog for the book
  title and author (project.json); it is disabled until the project has been saved once.
- **Touch and keyboard**: the toolbar button is the keyboard route (no hover-only access); every field is a native
  select, text field or checkbox with a visible label and a registry tooltip.

