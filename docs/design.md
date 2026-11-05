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
  hover-only. The toolbar (the ribbon) keeps one fixed-height row and scales its groups down instead of
  wrapping or scrolling (see "Ribbon"), and the dialog width is `min(28rem, 100vw - 2rem)`.

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
| `ToolbarGroup` | `label` (required) | A `role="group"` cluster (the ribbon scales whole groups, see "Ribbon") |
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
Number → Chapter Title) breaks once; the second block gets no break and no space before. A chapter number style
followed by a chapter title style (see the chapter rule below: built-ins, their duplicates and styles based on
them, in any mix) is the same group, as it is for the chapter model, so the number never sits alone on a page.

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
what it inherits. For a custom chapter heading, a one-line hint under Based on (`text-muted` on the dialog
surface, the existing AA pair; linked with `aria-describedby`; plain text, so no tooltip of its own) says whether
the style opens chapters ("Opens a chapter (based on Chapter Title)") or not ("Won't start chapters: base it on
Chapter Title to open a chapter"), and follows the draft as Kind and Based on change. Two columns from `md`, one column (form, then proof) on phones; the dialog widens to 48rem.

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
- **The chapter rule** (`chapterRoles` in `src/shared/book/styles.ts`): a style is a chapter title style when it is a chapter style (`kind: "chapter"`) at outline level 1 whose Based on chain reaches Chapter Title (Chapter Title itself included); a chapter number style likewise reaches Chapter Number first. Why this rule: "based on Chapter Title" is what a writer already says when they make a variant (a prologue or epilogue title), it is visible and editable in Modify style, and it keeps Part Title (also a level-1 chapter style) and its variants out, so parts never restart chapter numbering or running heads. A style based on Chapter Title but made a paragraph style or a level 2-3 heading (a subtitle) is not a chapter title. **Duplicate** of a built-in is therefore based on the built-in (with all its settings copied, so it looks identical): a duplicate of Chapter Title opens chapters, a duplicate of Chapter Number joins them, a duplicate of Part Title stays a part. A duplicate of a custom style keeps its parent. A chapter heading made from scratch (New, Kind "Chapter heading", based on Body or on nothing) does not open chapters until it is based on Chapter Title; Modify style says so next to Based on. Because a duplicate keeps the built-in as its parent, it also follows later edits to the built-in for every setting it does not set itself: the copy starts with the built-in's own settings, so what flows through is what the built-in left to inherit (its font family, say) and whatever is later cleared in the copy's Modify style. This inheritance is intended: a book-wide change to Chapter Title reaches its variants unless they chose otherwise.
- **Everything that depends on chapters follows the style sheet**, not only the document: pagination re-breaks on a style change (its chapter openings are recomputed every pass), running heads re-read chapter titles after a style change, and per-chapter footnote numbers are recomputed when a style change changes which styles open chapters (`chapterRoleSignature`).
- **"Chapters start on"** (next page / right-hand page) is not a new book field: it rewrites `breakBefore` of Chapter Title, and of every other chapter title or chapter number style that breaks at all (a style set to no break keeps it). A style with no break of its own that inherits it from a style rewritten in the same step is left alone, so it keeps following its parent.
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
  ("Pages 12–13 of 384", tabular figures; since Phase 3 a ghost button that opens Go to Page, with
  its tooltip and the Go to Page shortcut), the spread toggle (an open-book icon, pressed = two pages),
  zoom out, the zoom select (Fit spread / Fit width / 50–200 %) and zoom in. All are standard
  `IconButton` / `ToggleButton` / `Select` controls: 32 px targets, tooltips from the registry, keyboard
  reachable in the footer's tab order, existing contrast pairs.
- **Fit spread is the default zoom**: the whole spread fits the window, like holding the book open.
  Narrow windows fall back to single pages (touch-tolerant; no hover-only actions). A press on a margin
  or the desk puts the caret on the nearest line of that page.

### Navigation modes: Book and Continuous Scroll (Phase 3)

The user asked for the pages to behave "like an actual book instead of a goofy Word doc". So the
default navigation is **Book**: one spread (or one page) on the desk, centred, with no scrolling between
spreads. **Continuous Scroll** (the Phase 2 view, unchanged) is the alternative. The choice is an app
preference (`pageNavigation` in preferences.json, Settings > Page navigation, View > Book / Continuous
Scroll), not a book setting.

- **Turning pages.** Click or tap the blank desk right of the spread for the next one, left for the
  previous one. A press on the pages still places the caret. One wheel or trackpad gesture (a swipe and
  its momentum, horizontal too) turns one spread. Page Up / Page Down and Ctrl+Home / Ctrl+End (Cmd+Up /
  Cmd+Down on macOS) also turn, as does Go to Page.
- **Turn controls** sit in a 48 px lane on each side of the spread, at the middle of the window. They are
  small paper tabs: `--page-bg` with a 1 px border of `--page-fg` mixed 80 % into `--page-bg` (3:1 or more against the desk on every surface), a `--page-fg` chevron, and the
  page shadow, so they read as part of the book on every surface. They are 36 × 64 px targets, always
  visible (never hover-only), with tooltips, and reachable by Tab. A press does not take the focus from the
  manuscript. At the first or last spread the control is dimmed to 40 % and marked `aria-disabled`; it stays
  focusable, so its tooltip still explains it. They use `--page-focus-ring` for focus.
- **Turn transition.** A 160 ms ease-in (opacity 0.55 to 1, 14 px slide from the turning side). It is
  skipped when motion is reduced (Settings > Motion, or the OS setting). There is no page curl.
- **The caret drives the view.** When the selection moves off the spread (typing onto the next page,
  arrows, Find, Next Comment, a footnote), the view turns to it. Turning by hand leaves the caret where it
  is, and the next keystroke turns back to it, as in a word processor.

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

## Menus and commands (Phase 3)

One **command registry** (`src/shared/commands`) holds every user-facing action: id, label, a one-line description,
an optional shortcut (ProseMirror syntax, the only place a shortcut is declared), its menu place
(`{ id, group, order, submenu? }`), live `isEnabled()` / `isChecked()` and `run()`. Slices register their commands
through their public index (`registerStorageCommands`, `registerEditorCommands`, `registerPaginationCommands`,
`registerSurfaceCommands`, `registerBookSettingsCommands`, `registerHeaderFooterCommands`,
`registerFootnoteCommands`, `registerSettingsCommands`, `registerCommentsCommands`, `registerTrackChangesCommands`; the menu slice adds its own) and the composition root calls them. Ids reuse the matching
control's `data-control-id`, so a menu item, its toolbar button and its tooltip share one copy. A duplicate id or
shortcut, or a missing description, throws in development; `App.menus.test.tsx` checks the whole app's registry
(one-line descriptions of at most 100 characters, no shortcut twice, the same shortcut on a command and on its
control's tooltip). Nothing in the registry assumes a menu bar (tablet ports).

- **Rendering** (decision 4ec247fc): the macOS desktop app shows the **native global menu bar**, built in Rust
  (`src-tauri/src/menu.rs`, `menu_set`) from a serialized snapshot of the registry (ids, labels, accelerators,
  enabled/checked state, structure). The snapshot is re-sent when the registry changes and, debounced, when
  `notifyCommandStateChanged()` reports a state change; Rust updates enabled/checked in place when the structure is
  unchanged. Every item emits `menu://command` with its id. Cut, Copy, Paste, Select All, Services and Hide are the
  OS's own items there. Native macOS menu items cannot show tooltips: decision 4ec247fc exempts them; their
  description surface is the label, the accelerator and Help > Keyboard Shortcuts. **Windows** has no native menu:
  the themed **in-app menu bar** (Radix Menubar, menu slice) sits above the toolbar in the app shell. The web and e2e
  builds render the in-app bar too (`menuBarKind()`), so Playwright covers it on both engines. Both are built by
  `buildMenuModel`, so labels, order and shortcuts match. Menu `app` (About, Settings, Quit) is the macOS app menu;
  elsewhere About moves to Help and the rest to the end of File. An empty menu is left out.
- **Structure**: File (New Project…, Open Project…, Open Recent ▸, Close Project | Save, Save a Copy… | Book
  Details…, Page Setup ▸ | Settings… | Quit Novel; on macOS Settings… and Quit are in the Novel menu), Edit (Undo, Redo | Cut, Copy, Paste, Paste as Plain Text, Select All | Find…,
  Replace… | Go to Page…), View (Single Page, Two-Page Spread | Zoom In, Zoom Out, Fit Spread, Fit Width, Actual
  Size | Paper ▸ | Markup ▸ (All Markup, Simple Markup, No Markup, Original) | Comments Panel | Full Screen), Insert (Chapter Break, Page Break, Scene Break | Footnote,
  Comment), Format (Bold, Italic,
  Underline | Font ▸ (System Default and the installed families, as in the picker), Font Size ▸ | Paragraph Style ▸, Alignment ▸, Lists ▸, Line Spacing ▸, Space After ▸, First-Line Indent ▸ | Clear Formatting | Modify Style…, Manage Styles… |
  Headers & Page Numbers…, Footnote Options…), Review (Track Changes | New Comment | Next Comment, Previous Comment | Show Resolved
  Comments), Help (Keyboard Shortcuts, Project Folder Format | About Novel).
- **Keyboard** (one window listener, `installCommandShortcuts`): bubble phase, so a key the editor's keymap already
  handled is not run again; Cut/Copy/Paste keep the webview's own handling (`nativeShortcut`). Each command has a
  guard (`Command.guard`), applied to the key and to the native menu item alike: **manuscript** (Edit history and
  clipboard, Insert, Format, and New Comment, which anchors at the caret): not while another text field (the find
  field, a comment reply, the footnote popover) or a dialog has focus; **modal** (Track Changes, View > Markup): from
  any field, the footnote popover included, but not behind a dialog; **none** (everything else, e.g. Next / Previous
  Comment, Show Resolved Comments, Save): anywhere, so they work while typing in the comments panel. On macOS, a native menu event right after the same key press in the webview is ignored (`wasJustPressed`).
- **In-app bar**: Alt alone or F10 moves focus to File (again: back to the text), Alt+underlined letter opens a menu
  (not on macOS, where Option types characters), arrows move between menus and items, Enter/Space choose, Escape
  closes. Closing gives focus back to where it was (normally the manuscript, through its view, so the selection is
  exactly the one the user made) and only then runs the chosen command, as the toolbar does. Rows are 40px (touch),
  titles 32px; colours are the chrome tokens, so it follows light/dark and stays AA. Every title, submenu title and
  item has a tooltip (a registry entry, else its command's description) and is in the coverage audit.
- **Help**: Keyboard Shortcuts is generated from the registry (searchable); Project Folder Format renders the
  bundled `docs/project-format.md` (no network); About Novel shows the version from the app config (`getVersion`).

## Ribbon: the toolbar (Phase 3, T6)

The toolbar is a **ribbon modelled on Microsoft Word** (user decision on ticket ec20ef41: "follow how Word does it"):
tabs over one row of groups. It never wraps and never changes height (77px including the tab row), down to the
app's 480px minimum, and has no horizontal scrollbar.

What Word does, and what we took from it:
- **Tabs and groups.** Word's ribbon groups related commands under task tabs (Home, Insert, Layout, Review,
  View); each group has a name. We use Word's tab names and order and its group names where they fit.
- **Quick Access Toolbar.** Word keeps Undo/Redo outside the tabs so they are always one click away. Ours sit left of
  the tabs on every tab (`<Ribbon quickAccess>`).
- **Adaptive scaling.** As Word's window narrows, groups shrink one at a time, from large, to small, to icon only,
  then to a single **group button** that keeps the group's icon and name and opens the group as a dropdown. The
  order is set per group (the least used first, generally right to left). Ours: full → compact (where a group has
  one) → collapsed group button, ordered by group priority, and collapsing counts as a bigger loss than compacting.
- **Simplified ribbon overflow.** Word's single-line ribbon puts what does not fit behind a "…" button at the end
  of the row. Ours: below the minimum width the collapsed group buttons move into **More** at the end of the row
  (one flat menu, a titled section per group; submenus per group were tried and fell off the screen on narrow
  windows). At 480px and up nothing needs More today; it is there for narrow tablets.
- **Settings** is not on Word's ribbon (it is File > Options). Ours is File > Settings… (macOS: Novel > Settings…)
  and Mod-, only; the gear left the toolbar.
- Google Docs (one row, a "⋮" overflow on the right) and Pages (a small fixed toolbar with an inspector) show the
  same rule: a constant-height bar, with what does not fit behind one obvious button.

| Tab | Group (order) | Contents |
| --- | --- | --- |
| (all tabs) | Quick access | Undo, Redo |
| Home | Font | Font family, Font size; Bold, Italic, Underline. Compact: narrower fields |
| Home | Paragraph | Bulleted / numbered list; align left / center / right / justify; Line spacing, Space after, First-line indent; decrease / increase indent. Compact: the three fields move into a "Spacing" dropdown (registry submenus) |
| Home | Styles | Paragraph style picker, Modify style, Manage styles, Clear direct formatting |
| Home | Editing | Find, Replace |
| Insert | Breaks | Chapter Break, Page Break, Scene Break; Break Options (the Insert menu: also "Chapters start on" and the scene-break ornament). Compact: Break Options only (it holds the three breaks); never collapses, since a registry dropdown could not offer the two book settings |
| Insert | Footnotes | Footnote, Footnote options |
| Insert | Comments | Comment |
| Layout | Page Setup | Book size (trim size picker) |
| Layout | Header & Footer | Headers & page numbers |
| Layout | Paper | The paper surface picker |
| Layout | Book | Book Details |
| Review | Tracking | Track Changes, Markup |
| Review | Changes | Previous Change, Next Change; Accept ▾ and Reject ▾ (split buttons: the main half accepts / rejects the change at the cursor or in the selection; the arrow lists Accept Change, Accept and Move to Next, Accept All Changes and the Accept All by Author ▸ submenu, and the same for Reject) |
| Review | Comments | New Comment, Previous Comment, Next Comment, Show Resolved Comments |
| Review | Re-write | Re-write Passage…, Re-writes…, Previous Re-write, Next Re-write (the group's own buttons: an icon on the first, short labels Re-write / Re-writes / Previous / Next; tooltips and the dropdown keep the full names) |
| View | Views | Single Page, Two-Page Spread; Book, Continuous Scroll (two radio pairs: page view, then navigation mode; Previous / Next Spread are the turn controls on the canvas edges and View menu items, not ribbon buttons) |
| View | Zoom | Zoom Out, Zoom In, Fit Spread, Fit Width, Actual Size |
| View | Show | Comments panel |
| View | Window | Full Screen |

Priorities (higher keeps its size longer): Home Font 90, Styles 80, Paragraph 75, Editing 60 (never collapses: two
small buttons); Insert Breaks 90, Footnotes 80, Comments 70; Layout Page Setup 90, Header & Footer 80, Paper 70, Book
60; Review Tracking 90, Changes 85, Comments 80, Re-write 70; View Views 90, Zoom 80, Show 70, Window 60. A group
whose own controls are no wider than its group button (one icon) never collapses either; it only moves into More.

**Model** (`src/shared/ribbon`, data only; any slice may use it):
- `RIBBON_TABS` (fixed), `registerRibbonGroups([{ id: '<tab>.<name>', tab, label, order, priority, icon, Content?,
  hasCompact?, compactMenu?, compactButtons?, menu?, collapsible?, buttons? }])`. `Content` is the slice's own controls (each focusable
  one a Radix toolbar item, `ToolbarItem`), rendered with `size` 'full' or 'compact'. `menu` lists what the collapsed
  group / More shows: registry commands (`{ cmd }`) and registry submenus (`{ submenu: { menu, label } }`), so labels,
  shortcuts, enabled and checked state are the menu bar's. The app's groups are in `src/ribbon-groups.tsx`.
- **A command joins a group by its `ribbon` field** (`@/shared/commands`):
  `ribbon: { group: 'review.changes', order: 10 }` adds a labelled button for it to the group (and an item to the
  group's dropdown); `display: 'menu'` adds only the dropdown item (when the group's `Content` already has a control
  for it). Enabled and checked are read from the command on every render; renders follow the registry's
  debounced state signal, so a change made elsewhere (a shortcut, the menu) shows on the button up to
  `COMMAND_STATE_DEBOUNCE_MS` (120 ms) later, and a click on the button itself shows at once. The button's id is `ribbon.cmd.<command id>` (no clash with the menu item or another control for the same
  command); its tooltip is the command's label, description and shortcut. **T5, T7 and T8 add their buttons this
  way**: Review > Changes (Accept / Reject), Review > Re-write, View > Views (page-turn). A group with nothing to
  show is hidden, so those groups are registered already. A new group with custom controls is one entry in
  `src/ribbon-groups.tsx`.
- **Split buttons** (Word's "Accept ▾"): `SplitCommandButton` (`@/features/ribbon`) in a group's `Content`. The
  main half is the command's ribbon button (`ribbon.cmd.<id>`, an icon and a short label, "Accept"); the arrow is a
  registry dropdown (`RegistryMenu`) with its own control id and tooltip entry (`review.accept.options`,
  `review.reject.options`), listing commands and registry submenus. Both halves are 32px toolbar items. The command
  has no `ribbon` placement (it would show twice); the group's `menu` lists it for the collapsed group and More.
  Review > Changes: Previous / Next Change are placed by their commands (`buttons: 'before'`), the two split
  buttons are the group's `Content`.
- Each command id is shown once in the ribbon (inactive tabs stay mounted, hidden), so a `data-control-id` still
  names one element.

**Rendering and scaling** (`src/features/ribbon`): one Radix Toolbar holds the quick-access buttons, the tab list
(`role="tablist"`, buttons `role="tab"`) and the active tab panel, so the arrow keys move through all of them
(Home/End jump to the ends) and Escape on a control returns to the manuscript. A pointer press on a tab or a
command button does not take focus from the manuscript. `ribbonSteps()` lists the reduction steps (pure data);
the panel renders a step, measures the row's natural width (`offsetWidth` of a `w-max` row, before paint, with a
ResizeObserver on the bar and on the row) and `chooseStep()` picks the smallest step that fits. Growing back needs
24px to spare (hysteresis), so nothing flickers at a boundary width; unmeasured steps are tried before paint.
Collapsed groups keep their controls mounted (hidden): their dialogs (Modify / Manage styles) and state survive.
Group dropdowns and More come from the registry (`RegistryMenu`): opening reads the manuscript's pending selection,
choosing gives focus back to the manuscript and then runs the command (the selection is kept), Escape returns
focus to the button.

**Selected tab**: kept for the session (`sessionStorage`); a new app start opens on Home.

**Status bar**: one row as well (`h-statusbar`, no wrap, never clipped). The footer is a named container
(`@container/statusbar`) and its items shrink with container queries, lowest priority first: below 800px the
no-project buttons (Save as project…, New project…, Open project…) show icons (their names stay); below 760px the
page indicator shortens to "12 / 384" and below 560px it hides; below 640px zoom keeps only its menu (every level and
the fit modes; spread is on the View tab), "Backup available — Restore…" becomes "Restore…" and the tracked changes
count ("12 changes", T7) shows just the number ("No changes" hides). The save status
and warnings truncate (full text in the title). Hidden items are `display: none`, so they are out of the Tab order.

**Tests**: `src/features/ribbon/layout.test.ts` (step order, hysteresis, stability),
`src/features/editor/toolbar/use-toolbar-state.test.tsx` (one shared reading per transaction, detach / re-attach,
editor swap), `src/features/editor/paragraph-spacing-commands.test.tsx`, `e2e/ribbon.spec.ts` (resizing in 20px steps
from 1400 to 480 and back on all five tabs: one row, constant height, no canvas jump, monotone and stable placement,
±2px jitter at each boundary; each group's commands reachable at 1100/800/600/480 on all five tabs, in the bar or
through the group's menu, its collapsed button or More; keyboard access to collapsed groups and More; formatting from
a dropdown keeps the selection; tab kept for the session; AA contrast on the four papers in light and dark at 1280,
480 and 360, collapsed-group icons at 3:1, open group and More menus), `e2e/statusbar.spec.ts` (480/600/800 with and
without a project, and with tracked changes: every visible control inside the footer, nothing hidden focusable), `e2e/toolbar.spec.ts`
(control count, 32px targets).
Screenshots: `scripts/capture-ribbon.mjs`.

## Comments (Phase 3)

Slice `src/features/comments/` (public interface `index.ts`). Format: docs/project-format.md, "comments.json".

- **Anchor**: the inline `comment` mark (attr `id`; `excludes: ''`, so comments overlap each other and any other
  mark, track changes included). A collapsed caret comments the word at the caret. The anchored text gets a soft
  paper highlight (`--page-comment-bg`, comments.css, one value per paper surface); a thread with an author colour
  gets that colour mixed into the paper, as strong as AA for the page text allows on the current paper
  (`highlightFor`, checked in `comments/model.test.ts` for a palette on all four papers). The selected thread uses
  `--page-comment-active-bg` and a `--page-comment-ring` underline (3:1). Resolved threads lose the highlight unless
  Show Resolved is on. All of it is one generated style sheet: nothing changes per keystroke, and no box changes,
  so the pagination measurement is untouched.
- **Undo**: thread data lives in the editor's plugin state and changes only through a document step that leaves
  the text as it is (`CommentThreadStep`), so create, reply, edit, resolve, reopen and delete are each one step of
  the main undo history (with their marks, for create and delete). The store's `comments` slice mirrors it for the
  panel and for comments.json.
- **Margin panel**: to the right of the pages, on the desk (the pages fit into what is left). Cards hold the author,
  a colour dot, a relative date, the messages, Reply, Resolve / Reopen, Go to text and Delete. Each card is level with
  its anchor's line (painted position: page offsets and zoom included) and cards stack downward without overlap; the
  selected card is pulled to its anchor and the ones above it stack upward (Word / Google Docs). Only the visible
  spread's comments are shown (`layout.pages` + `visibleSpread`, never the scroll position), recomputed on every
  published reflow, zoom and spread change. The panel takes room only while the manuscript has comments (resolved
  ones included, so Show Resolved stays at hand).
- **Connector, never hover alone**: the caret in an anchor, focusing a card and clicking it select the thread (card
  ringed, anchor lit); hovering a card or its anchor text lights the other side too.
- **Narrow windows**: when the pages at a readable size plus the panel do not fit, the comments become a toggleable
  side drawer (a bottom sheet below 640 px) listing the threads in document order; Go to text jumps to the anchor.
- **Commands**: New Comment (Mod-Alt-m; opens a focused composer, Mod-Enter adds, Escape cancels and returns to the
  text), Next / Previous Comment (the anchor is centred so its spread is the one in view; both page views), Show
  Resolved, Comments Panel toggle. Mod-z / Mod-Shift-z in the panel (outside its text fields) undo in the manuscript.
  Toolbar: `comment.new`, `comment.panel`; every panel and card control has a registry tooltip. Menus (command
  registry): Review > New Comment (Mod-Alt-m), Next / Previous Comment, Show Resolved Comments (check); Insert >
  Comment (the same action; the shortcut is shown on Review's); View > Comments Panel (check). Next / Previous are
  enabled while some thread is shown (resolved ones only with Show Resolved).
- **Author**: the Settings author (`getAuthor()`), "Unknown author" when no name is known. When no name is known
  and the one-time question was never asked, New Comment asks it first and opens the composer after the answer.

## Track changes: Review group (Phase 3)

Toolbar group "Review": the Track Changes toggle (`review.track`, Mod-Shift-e; a toggle button with a pen icon,
its label shown from the `xl` breakpoint, pressed while recording) and the Markup picker (`review.markup`, a
dropdown whose trigger shows the current view, radio items All Markup / Simple Markup / No Markup / Original, 40 px
rows). On the page, marks never recolour text, so text contrast is the page's own on every paper; insertions get a
2 px underline, deletions a 2 px strike-through, formatting changes a dotted rule, and changed blocks / lines a 3 px
bar 12 px into the inside margin, all in per-surface `--page-tc-*` colours with at least 3:1 against the paper (or
the author's colour when settings give one). Details: docs/track-changes.md.

## Re-write (Phase 3)

Slice `src/features/rewrite/` (public interface `index.ts`). Format: docs/project-format.md, "rewrites.json".
The signature feature: a passage rewritten beside its original, compared like two facing pages of the book.

- **Open**: Review ▸ Re-write Passage… (Mod-Alt-w) on the selection widened to whole paragraphs, or the paragraph
  at the caret; at most one chapter (a wider selection is refused with a notice). A selection inside a passage
  already in re-write opens that re-write. The spec's selection context menu entry is deferred out of Phase 3:
  the app has no context menus anywhere.
- **Menus while the view is open**: one mechanism for the menu bar (pointer and keyboard), the native menu and
  shortcuts. Text commands (formatting, styles, paragraph spacing, Edit history / clipboard, Insert breaks) act
  through the editor slice's active editor (`getActiveEditor()`), which the view points at the revision while it
  has the focus; with the focus elsewhere in the view they are disabled (Edit history / clipboard in the
  version-name field act on that field). A registry command gate
  (`setCommandGate`) disables what makes no sense on a revision: Insert Footnote, comments, Find / Replace, Track
  Changes, Go to Page, page view and zoom. Copy stays available on both pages. The pages behind the view do not
  scroll.
- **The spread**: the comparison view lies over the pages (they stay mounted, laid out and scrolled where they
  were, so opening costs no reflow). Two pages on the desk at the book's trim width, margins and paper surface
  (`.nv-page`, verso / recto spine shading), typeset by the book style sheet with the manuscript's base face: the
  original on the left (read-only, focusable to read and select), the revision on the right (an editor with the
  manuscript's schema: `createEditorExtensions({ detached: true })`, which leaves out what belongs to the
  manuscript's one view: comment threads, tracked-change recording, the footnote editor, the re-write lock). The
  labels above the pages are set on the desk; the regions are announced as "Original" and "Revised version N". One
  scroller holds both pages, so they always scroll together.
- **Alignment**: the blocks of both sides are aligned (word-similarity global alignment, `align.ts`): paired
  paragraphs start level, an inserted or removed paragraph leaves a gap opposite it. Levelling is `padding-top` on
  the higher block (a node decoration; padding never changes margin collapsing), measured per frame after a
  change; the pairing itself is redone at once when a paragraph is added or removed, otherwise 150 ms after typing.
- **The spine** (the one memorable element): the gutter between the pages carries one stitch per aligned row: a
  ring for an unchanged paragraph, a filled ink stitch for a changed one, a short red or green dash for a paragraph
  only the original or only the revision has. Decorative (aria-hidden); the differences themselves are in the text.
- **Differences** (toggle, Mod-Shift-d, on by default): removed words on the original get a rose tint and a
  strike-through, added words on the revision a green tint and an underline; whole unpaired paragraphs get the
  tint and a bar in the margin. Word diff: jsdiff `diffWordsWithSpace` (BSD-3-Clause). Per-surface tokens
  `--page-rw-*` (rewrite.css): page text keeps 4.5:1 on every tint, rules and stitches 3:1 (rewrite.test.tsx).
- **Versions**: tabs above the pages (arrow keys move and select; double-click or the pen renames inline; New
  version copies the version shown). Each version keeps its own undo history while the view is open (undo is local
  to the revision). Flip Pages (Mod-Alt-k) swaps the sides; Go to Left / Right Page (Mod-Alt-ArrowLeft / Right)
  moves the focus between them. Escape or Close returns to the manuscript; the re-write stays a draft.
- **Undo** is never blocked. When an undo or redo in the manuscript changes text in an open re-write's passage,
  the re-write is marked "original changed" (the view offers Show current text) and a short notice says so
  ("Undo changed text in a passage that is in re-write."), over the view too; it goes after a few seconds or when the
  caret moves. An edit that removes the whole passage (undoing the paragraphs' insertion) or leaves it in pieces
  says so instead ("The passage for this re-write was removed. Its versions are kept; reopen it to copy text
  out."); the view shows the same in its banner and the Re-writes list marks it. When a redo or undo puts the same
  blocks back where the passage was, they are anchored again (only blocks the undo or redo inserted itself) and the notice goes. The history
  group is closed when a re-write starts, so typing from before is never merged with later edits. Comments can be added to and removed
  from the passage.
- **In the manuscript** an open re-write's passage is read-only and marked by a faint `--page-rw-lock-bg` tint and
  a dashed "tacking stitch" bar in the left margin with a ring at its top (pseudo-elements: no box changes, so
  pagination is untouched). A click on the bar reopens the re-write; so do the notice that floats over the pages
  while the caret is in the passage (stronger after an edit there was refused), Review ▸ Re-writes… and Next /
  Previous Re-write.
- **Narrow windows** (two pages do not fit): one page at a time, with an Original / Revised toggle in the header;
  the focus keys switch pages too.
- **Ribbon**: Review ▸ Re-write group: Re-write Passage… (`rewrite.open`, with the re-write icon), Re-writes…
  (`rewrite.list`), Previous / Next Re-write (`rewrite.prev`, `rewrite.next`). The group's `Content` shows them
  as command buttons with short labels (Re-write, Re-writes, Previous, Next) so the group stays full at 1280px;
  the commands' `ribbon` placements are `display: 'menu'` (the collapsed group and More list the full names).
- **While the view is open the ribbon follows the command gate**, like the menus: registry buttons read
  `isCommandEnabled` (gate included); the slices' own controls for gated commands (Find, New Comment, Track
  Changes) are disabled with their command (`GatedItem` in src/ribbon-groups.tsx); the formatting controls, Undo /
  Redo and Break Options act on the active editor (`useActiveEditor`, the revision while it has the focus, else
  off). The track changes review (Previous / Next Change, Show Change Details, Accept / Reject and their All / by
  Author variants) is off while the view is open: it acts on the hidden manuscript. The re-write's editors are
  `TrackChanges.configure({ detached: true, review: false })` (`detached` implies no review side), so the review
  commands, popover and count always act on the manuscript.
