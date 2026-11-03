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
