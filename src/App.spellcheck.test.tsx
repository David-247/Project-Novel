import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { getEditor, openEditorContextMenu, setDocJSON } from '@/features/editor'
import { __resetSpellcheckCacheForTests } from '@/features/spellcheck'
import { auditTooltipCoverage, formatCoverageProblems } from '@/features/tooltips'
import { getCommand, isCommandEnabled, runCommand } from '@/shared/commands'
import { useStore } from '@/shared/store'
import { backend } from '@/test-utils/fake-tauri'
import { App } from './App'

vi.mock('@tauri-apps/api/core', async () => (await import('@/test-utils/fake-tauri')).coreModule)
vi.mock('@tauri-apps/plugin-dialog', async () => (await import('@/test-utils/fake-tauri')).dialogModule)
vi.mock('@tauri-apps/plugin-sql', async () => (await import('@/test-utils/fake-tauri')).sqlModule)
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    theme: async () => null,
    onThemeChanged: async () => () => {},
    onCloseRequested: async () => () => {},
    destroy: async () => {},
    isFullscreen: async () => false,
    setFullscreen: async () => {},
  }),
}))
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }))
vi.mock('@tauri-apps/api/app', () => ({ getVersion: async () => '0.4.0' }))

// Spell check in the whole app (Phase 5 T5): the composition root wires the underlines, the context
// menu items and View ▸ Spelling & Grammar.

beforeAll(() => {
  const rect = { x: 0, y: 0, top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, toJSON: () => ({}) }
  const emptyRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList
  Range.prototype.getClientRects ??= emptyRects
  Range.prototype.getBoundingClientRect ??= () => rect as DOMRect
  Element.prototype.getClientRects ??= emptyRects
  document.elementFromPoint ??= () => null
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  if (!('fromRect' in DOMRect)) (DOMRect as unknown as { fromRect: (r: Partial<DOMRect>) => DOMRect }).fromRect = (r) => new DOMRect(r.x, r.y, r.width, r.height)
})

beforeEach(() => {
  backend.reset()
  __resetSpellcheckCacheForTests()
})

afterEach(() => {
  cleanup()
  setDocJSON({ type: 'doc', content: [{ type: 'paragraph' }] })
  act(() => useStore.getState().preferencesActions.set('spellcheck', { enabled: true, words: [] }))
})

const underlined = () => [...document.querySelectorAll('.novel-editor-content .spell-error')].map((e) => e.textContent)

async function appWith(text: string) {
  render(<App />)
  await waitFor(() => expect(getEditor()).not.toBeNull())
  act(() => setDocJSON({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }))
  await waitFor(() => expect(underlined()).toEqual(['teh']), { timeout: 3000 })
}

describe('spell check in the app', () => {
  it('the manuscript is not checked by the webview (spellcheck="false"); Harper underlines it', async () => {
    await appWith('I saw teh dog.')
    expect(screen.getByRole('textbox', { name: 'Manuscript' })).toHaveAttribute('spellcheck', 'false')
  })

  it('the context menu shows suggestions, Ignore Once, Add to Dictionary, then Cut / Copy / Paste, every item with a tooltip', async () => {
    await appWith('I saw teh dog.')
    act(() => {
      openEditorContextMenu({ pos: 8, x: 20, y: 20 })
    })
    const menu = await screen.findByRole('menu')
    const items = [...menu.querySelectorAll('[role="menuitem"]')]
    expect(items.map((i) => i.querySelector('span')?.textContent)).toEqual(['the', 'Ignore Once', 'Add to Dictionary', 'Cut', 'Copy', 'Paste'])
    expect(menu.querySelectorAll('[role="separator"]')).toHaveLength(2)
    const problems = auditTooltipCoverage(document.body)
    expect(problems, formatCoverageProblems(problems)).toEqual([])
    // The suggestion's tooltip names its word.
    expect(screen.getByRole('menuitem', { name: 'the' })).toHaveAccessibleDescription(/“teh” becomes “the”/)
    fireEvent.keyDown(menu, { key: 'Escape' })
  })

  it('View > Spelling & Grammar toggles the underlines and is saved in preferences', async () => {
    await appWith('teh')
    const cmd = getCommand('view.spellcheck')!
    expect(cmd.menu).toMatchObject({ id: 'view' })
    expect(cmd.ribbon).toMatchObject({ group: 'review.proofing' })
    expect(isCommandEnabled(cmd)).toBe(true)
    expect(cmd.isChecked!()).toBe(true)
    act(() => {
      runCommand('view.spellcheck')
    })
    expect(useStore.getState().preferences.spellcheck.enabled).toBe(false)
    expect(cmd.isChecked!()).toBe(false)
    expect(underlined()).toEqual([])
    act(() => {
      runCommand('view.spellcheck')
    })
    await waitFor(() => expect(underlined()).toEqual(['teh']), { timeout: 3000 })
  })
})
