import { useSyncExternalStore } from 'react'
import { DEFAULT_STYLE_ID } from '@/shared/book'
import { blockPlainText } from '../block-text'
import { getEditor } from '../controller'
import { readToolbarState } from '../toolbar/toolbar-state'
import { getResolvedStyles } from './resolved'

/**
 * Which style dialog is open, shared by the toolbar's Styles group and the Format menu commands.
 * Module state: one window, one set of dialogs.
 */
export interface StyleDialogState {
  /** Style being modified, or null. */
  modifying: string | null
  managing: boolean
  /** Text of the paragraph the Modify dialog previews. */
  sample?: string
}

let state: StyleDialogState = { modifying: null, managing: false }
const listeners = new Set<() => void>()

function set(next: Partial<StyleDialogState>) {
  state = { ...state, ...next }
  listeners.forEach((l) => l())
}

/** Open Modify style for the style of the paragraph at the selection (or Body). */
export function openModifyStyle(): void {
  const ed = getEditor()
  const s = readToolbarState(ed)
  const styles = getResolvedStyles()
  const block = ed?.state.selection.$from.parent
  set({
    sample: block ? blockPlainText(block).slice(0, 280) : undefined,
    modifying: styles.has(s.styleId) ? s.styleId : s.fallbackStyleId || DEFAULT_STYLE_ID,
  })
}

/** Open Modify style for `id`, without a sample (from Manage styles). */
export function modifyStyle(id: string | null): void {
  set({ modifying: id, sample: undefined })
}

export function setManagingStyles(managing: boolean): void {
  set({ managing })
}

export function useStyleDialogs(): StyleDialogState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => state,
    () => state,
  )
}
