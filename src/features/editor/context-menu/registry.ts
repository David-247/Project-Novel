import type { Editor } from '@tiptap/core'
import type { Selection } from '@tiptap/pm/state'
import type { TooltipCopy } from '@/shared/ui'

/**
 * The manuscript's context menu (right-click, Shift+F10, the Menu key), Word style. Any slice adds
 * items through registerContextMenuItems (editor slice's index) without the editor knowing it: a
 * provider is asked for its items each time the menu opens, with where it opened.
 *
 * Order: items sort by `order`; consecutive items of one `group` form a section, sections are
 * separated by a line. Ranges (Word's order): suggestions 0-99, proofing (Ignore Once, Add to
 * Dictionary) 100-199, other actions (Ask the Tutor About This) 200-299, the clipboard 300-399.
 */
export interface ContextMenuContext {
  editor: Editor
  /** The document position the menu is about: the pointer's place, or the caret for the keyboard. */
  pos: number
  /** The selection when the menu opened (a right-click outside it moved the caret there first). */
  selection: Selection
}

export interface MenuItem {
  /** `data-control-id`: needs an entry in the tooltips registry (or a registry command of that id). */
  id: string
  label: string
  group: string
  order: number
  /** Tooltip copy that names this instance (a suggestion: its word); the id still names the control. */
  copy?: TooltipCopy
  disabled?: boolean
  /** Shown bold, as Word shows its spelling suggestions. */
  emphasis?: boolean
  /** Shortcut shown at the right (display only). */
  shortcut?: string
  run: () => void
}

export type ContextMenuProvider = (ctx: ContextMenuContext) => MenuItem[]

const providers = new Set<ContextMenuProvider>()

/** Add items to the manuscript's context menu. Returns unregister. */
export function registerContextMenuItems(provider: ContextMenuProvider): () => void {
  providers.add(provider)
  return () => {
    providers.delete(provider)
  }
}

/** The menu's items for `ctx`, sorted, in sections. A provider that throws is skipped (logged). */
export function contextMenuSections(ctx: ContextMenuContext): MenuItem[][] {
  const items: MenuItem[] = []
  for (const p of providers) {
    try {
      items.push(...p(ctx))
    } catch (e) {
      console.error('[context menu] a provider failed', e)
    }
  }
  items.sort((a, b) => a.order - b.order)
  const sections: MenuItem[][] = []
  for (const it of items) {
    const last = sections[sections.length - 1]
    if (last && last[0].group === it.group) last.push(it)
    else sections.push([it])
  }
  return sections
}

/** Test-only. */
export function __resetContextMenuForTests(): void {
  providers.clear()
}
