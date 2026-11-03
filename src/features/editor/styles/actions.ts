import {
  DEFAULT_STYLE_ID,
  isBuiltInStyle,
  newStyleId,
  removeStyle,
  styleDefinitions,
  writeStyle,
  type StyleDef,
} from '@/shared/book'
import { useStore } from '@/shared/store'
import { getEditor } from '../controller'
import { countBlocksWithStyle, remapStyleInDoc } from './block-styles'
import { resolveStyles } from './resolved'

// Manuscript-wide style operations. Definitions live in the book slice (`book.styles`, persisted
// in book.json by storage); these only write the store, except delete, which also re-maps blocks.

const book = () => useStore.getState().book
const setStyles = (u: Parameters<ReturnType<typeof useStore.getState>['bookActions']['setStyles']>[0]) =>
  useStore.getState().bookActions.setStyles(u)

/** A definition without its builtIn flag (what writeStyle takes). */
export function ownDef(def: StyleDef): Omit<StyleDef, 'builtIn'> {
  const own: Partial<StyleDef> = { ...def }
  delete own.builtIn
  return own as Omit<StyleDef, 'builtIn'>
}

/** The style's own (unresolved) definition, built-in overrides merged. */
export function getStyleDefinition(id: string): StyleDef | undefined {
  return styleDefinitions(book().styles).get(id)
}

/** Saves a definition (Modify style). Built-ins keep their name, kind and parent. */
export function saveStyle(id: string, def: Omit<StyleDef, 'builtIn'>): void {
  setStyles((s) => writeStyle(s, id, def))
}

/** Puts a built-in style back to its registered default. */
export function resetStyle(id: string): void {
  if (!isBuiltInStyle(id)) return
  setStyles((s) => {
    if (!(id in s)) return s
    const next = { ...s }
    delete next[id]
    return next
  })
}

function uniqueName(base: string): string {
  const names = new Set([...resolveStyles(book().styles).values()].map((s) => s.name.toLowerCase()))
  if (!names.has(base.toLowerCase())) return base
  for (let n = 2; ; n++) if (!names.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`
}

/** New custom style based on `basedOn` (same kind). Returns its id. */
export function createStyle(basedOn: string = DEFAULT_STYLE_ID, name = 'New style'): string {
  const styles = resolveStyles(book().styles)
  const parent = styles.get(basedOn) ?? styles.get(DEFAULT_STYLE_ID)!
  const id = newStyleId(styles.keys())
  const def: Omit<StyleDef, 'builtIn'> = { name: uniqueName(name.trim() || 'New style'), kind: parent.kind, basedOn: parent.id }
  if (parent.kind === 'chapter' && parent.outlineLevel) def.outlineLevel = parent.outlineLevel
  setStyles((s) => writeStyle(s, id, def))
  return id
}

/** Copy of a style (its own settings and parent) under a new name. Returns the new id. */
export function duplicateStyle(sourceId: string): string | null {
  const styles = resolveStyles(book().styles)
  const source = styleDefinitions(book().styles).get(sourceId)
  if (!source) return null
  const id = newStyleId(styles.keys())
  // Same own settings and the same parent, so the copy looks identical.
  const def = { ...ownDef(source), name: uniqueName(`${source.name} copy`) }
  setStyles((s) => writeStyle(s, id, def))
  return id
}

/** Renames a custom style. Returns false for built-ins or an empty name. */
export function renameStyle(id: string, name: string): boolean {
  const trimmed = name.trim()
  const def = getStyleDefinition(id)
  if (!def || def.builtIn || !trimmed) return false
  setStyles((s) => writeStyle(s, id, { ...ownDef(def), name: trimmed.slice(0, 80) }))
  return true
}

/** Where a deleted style's blocks go: its parent, or Body. */
export function deleteTarget(id: string): string {
  const resolved = resolveStyles(book().styles).get(id)
  return resolved?.basedOn ?? DEFAULT_STYLE_ID
}

/** How many blocks use a style now (O(document)). */
export function countStyleUses(id: string): number {
  const ed = getEditor()
  return ed ? countBlocksWithStyle(ed.state.doc, id) : 0
}

/**
 * Deletes a custom style: its blocks are re-mapped to its parent (or Body) in one document change
 * (not an undo step, since the definition is gone), and styles based on it inherit from its parent.
 * Returns the number of blocks re-mapped, or null when the style cannot be deleted.
 */
export function deleteStyle(id: string): number | null {
  if (isBuiltInStyle(id) || !getStyleDefinition(id)) return null
  const targetId = deleteTarget(id)
  const nextStored = removeStyle(book().styles, id, targetId)
  const target = resolveStyles(nextStored).get(targetId) ?? resolveStyles(nextStored).get(DEFAULT_STYLE_ID)!
  let remapped = 0
  const ed = getEditor()
  if (ed) {
    const tr = ed.state.tr
    remapped = remapStyleInDoc(tr, id, target)
    if (tr.docChanged) ed.view.dispatch(tr.setMeta('addToHistory', false))
  }
  setStyles(nextStored)
  return remapped
}
