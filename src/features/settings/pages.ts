import { useSyncExternalStore } from 'react'
import type { ComponentType } from 'react'

/**
 * Extra pages of the Settings dialog, listed after General down its left side (Word's Options
 * dialog). Another slice's page is registered from the composition root, so this slice never imports
 * it: `registerSettingsPage({ id: 'ai-tutor', label: 'AI Tutor', component: AiTutorSettings })`.
 */
export interface SettingsPage {
  /** Stable id, also what `openSettings(id)` opens. */
  id: string
  /** The page's name in the list (and its heading). */
  label: string
  /** One line for the page's tooltip in the list. */
  description?: string
  component: ComponentType
}

/** The built-in first page. */
export const GENERAL_PAGE_ID = 'general'

let pages: readonly SettingsPage[] = []
const listeners = new Set<() => void>()
const notify = () => listeners.forEach((l) => l())

/** Add a page (a page with the same id is replaced). Returns unregister. */
export function registerSettingsPage(page: SettingsPage): () => void {
  if (page.id === GENERAL_PAGE_ID) throw new Error(`"${GENERAL_PAGE_ID}" is the built-in Settings page.`)
  pages = [...pages.filter((p) => p.id !== page.id), page]
  notify()
  return () => {
    if (!pages.includes(page)) return
    pages = pages.filter((p) => p !== page)
    notify()
  }
}

export const getSettingsPages = (): readonly SettingsPage[] => pages

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function useSettingsPages(): readonly SettingsPage[] {
  return useSyncExternalStore(subscribe, getSettingsPages, getSettingsPages)
}
