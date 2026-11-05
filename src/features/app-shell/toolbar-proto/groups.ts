/**
 * T6 step 1 (prototype): what the single-row toolbar prototypes know about the toolbar's groups.
 * Each entry names a `ToolbarGroup` by its accessible label (the DOM is matched by
 * `[role=group][aria-label]`), how long it stays on the bar, which ribbon tab holds it, and the
 * registry entries that stand in for it in an overflow or group dropdown.
 */

/** An entry of a dropdown: a registry command, or a submenu of the registry's menu model. */
export type ProtoEntry = { cmd: string } | { submenu: { menu: 'file' | 'edit' | 'view' | 'insert' | 'format' | 'review'; label: string } }

export type ProtoTab = 'home' | 'insert' | 'layout' | 'review' | 'view'

export interface ProtoGroup {
  /** The `ToolbarGroup` label in the bar. */
  label: string
  /** Higher stays on the bar longer (overflow mode collapses the lowest first). */
  priority: number
  tab: ProtoTab | 'always'
  entries: ProtoEntry[]
  /** Registry controls with no command yet (shown as a note in the prototype dropdown). */
  missing?: string[]
}

const cmd = (id: string): ProtoEntry => ({ cmd: id })
const sub = (menu: Extract<ProtoEntry, { submenu: unknown }>['submenu']['menu'], label: string): ProtoEntry => ({ submenu: { menu, label } })

export const PROTO_GROUPS: ProtoGroup[] = [
  { label: 'History', priority: 100, tab: 'always', entries: [cmd('history.undo'), cmd('history.redo')] },
  { label: 'Font', priority: 90, tab: 'home', entries: [sub('format', 'Font'), sub('format', 'Font Size')] },
  { label: 'Text style', priority: 95, tab: 'home', entries: [cmd('toolbar.bold'), cmd('toolbar.italic'), cmd('toolbar.underline')] },
  { label: 'Lists', priority: 55, tab: 'home', entries: [cmd('toolbar.bulletList'), cmd('toolbar.orderedList')] },
  {
    label: 'Alignment',
    priority: 70,
    tab: 'home',
    entries: [cmd('toolbar.alignLeft'), cmd('toolbar.alignCenter'), cmd('toolbar.alignRight'), cmd('toolbar.alignJustify')],
  },
  {
    label: 'Spacing and indent',
    priority: 40,
    tab: 'home',
    entries: [cmd('toolbar.indentDecrease'), cmd('toolbar.indentIncrease')],
    missing: ['Line spacing', 'Space after paragraph', 'First-line indent'],
  },
  {
    label: 'Styles',
    priority: 85,
    tab: 'home',
    entries: [sub('format', 'Paragraph Style'), cmd('styles.clearFormatting'), cmd('styles.edit'), cmd('styles.manage')],
  },
  { label: 'Find', priority: 80, tab: 'home', entries: [cmd('find.open'), cmd('edit.replace')] },
  {
    label: 'Insert',
    priority: 50,
    tab: 'insert',
    entries: [cmd('insert.newChapter'), cmd('insert.pageBreak'), cmd('insert.sceneBreak'), cmd('footnote.insert'), cmd('footnote.options')],
  },
  { label: 'Review', priority: 65, tab: 'review', entries: [cmd('review.track'), sub('view', 'Markup')] },
  { label: 'Paper', priority: 25, tab: 'layout', entries: [sub('view', 'Paper')] },
  { label: 'Book layout', priority: 30, tab: 'layout', entries: [sub('file', 'Page Setup'), cmd('book.headerFooter'), cmd('book.details')] },
  {
    label: 'Comments',
    priority: 60,
    tab: 'review',
    entries: [cmd('comment.new'), cmd('comment.prev'), cmd('comment.next'), cmd('comment.panel')],
  },
  { label: 'App', priority: 20, tab: 'view', entries: [cmd('settings.open')] },
]

export const groupByLabel = new Map(PROTO_GROUPS.map((g) => [g.label, g]))

/**
 * "groups" prototype: the bar's groups merged into the units a writer thinks in. Each unit collapses
 * to one dropdown button. Units without `glyph` never collapse (one small button already).
 */
export interface ProtoUnit {
  id: string
  label: string
  /** Has an icon (shown when even the labelled dropdowns do not fit); absent = never collapses. */
  glyph?: string
  groups: string[]
  priority: number
}

export const PROTO_UNITS: ProtoUnit[] = [
  { id: 'history', label: 'History', groups: ['History'], priority: 100 },
  { id: 'font', label: 'Font', glyph: 'A', groups: ['Font', 'Text style'], priority: 90 },
  { id: 'paragraph', label: 'Paragraph', glyph: 'p', groups: ['Lists', 'Alignment', 'Spacing and indent'], priority: 60 },
  { id: 'styles', label: 'Styles', glyph: 'Aa', groups: ['Styles'], priority: 80 },
  { id: 'find', label: 'Find', groups: ['Find'], priority: 100 },
  { id: 'insert', label: 'Insert', glyph: '+', groups: ['Insert'], priority: 50 },
  { id: 'review', label: 'Review', glyph: 'r', groups: ['Review', 'Comments'], priority: 70 },
  { id: 'layout', label: 'Layout', glyph: 'l', groups: ['Paper', 'Book layout'], priority: 40 },
  { id: 'view', label: 'View', groups: ['App'], priority: 100 },
]

export const PROTO_TABS: { id: ProtoTab; label: string }[] = [
  { id: 'home', label: 'Home' },
  { id: 'insert', label: 'Insert' },
  { id: 'layout', label: 'Layout' },
  { id: 'review', label: 'Review' },
  { id: 'view', label: 'View' },
]

/** View tab: registry View commands (they have no bar controls yet; zoom lives in the status bar). */
export const VIEW_TAB_ENTRIES: ProtoEntry[] = [
  cmd('view.singlePage'),
  cmd('pagination.spreadView'),
  cmd('pagination.zoomOut'),
  cmd('pagination.zoomIn'),
  cmd('view.fitWidth'),
  cmd('view.fullScreen'),
]

export type ToolbarProtoMode = 'overflow' | 'tabs' | 'groups'

/** `?toolbar=overflow|tabs|groups` (dev and e2e builds only); null = the shipping toolbar. */
export function readToolbarProtoFlag(search: string = typeof location === 'undefined' ? '' : location.search): ToolbarProtoMode | null {
  if (!import.meta.env.DEV && import.meta.env.MODE !== 'e2e') return null
  const v = new URLSearchParams(search).get('toolbar')
  return v === 'overflow' || v === 'tabs' || v === 'groups' ? v : null
}
