import { act, cleanup, render, renderHook } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { registerBookSettingsCommands } from '@/features/book-settings'
import { registerCommentsCommands } from '@/features/comments'
import { getEditor, NovelEditor, registerEditorCommands, setActiveEditorSource, setDocJSON } from '@/features/editor'
import { registerFootnoteCommands } from '@/features/footnotes'
import { registerHeaderFooterCommands } from '@/features/header-footer'
import { registerMenuCommands } from '@/features/menu'
import { registerPaginationCommands } from '@/features/pagination'
import { registerSettingsCommands } from '@/features/settings'
import { registerStorageCommands } from '@/features/storage'
import { registerTrackChangesCommands } from '@/features/track-changes'
import { __resetCommandsForTests, COMMAND_STATE_DEBOUNCE_MS, commandGateAllows, getCommand, getCommands, isCommandEnabled, setCommandGate, useCommandGateAllows } from '@/shared/commands'
import { registerSurfaceCommands } from '@/shared/theme'
import { rewriteCommandGate } from './gate'
import { registerRewriteCommands } from './menu-commands'

/**
 * The re-write view's command gate against the REAL registry (every slice's commands, as the app
 * registers them): a new Review or View pages command, or a renamed id, must not leak onto the
 * hidden manuscript.
 */

beforeAll(() => {
  const rect = { x: 0, y: 0, top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, toJSON: () => ({}) }
  const emptyRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList
  Range.prototype.getClientRects ??= emptyRects
  Range.prototype.getBoundingClientRect ??= () => rect as DOMRect
  Element.prototype.getClientRects ??= emptyRects
  document.elementFromPoint ??= () => null
})

let offs: (() => void)[] = []
beforeAll(() => {
  __resetCommandsForTests()
  offs = [
    registerStorageCommands(),
    registerEditorCommands(),
    registerPaginationCommands(),
    registerBookSettingsCommands(),
    registerHeaderFooterCommands(),
    registerFootnoteCommands(),
    registerSettingsCommands(),
    registerCommentsCommands(),
    registerTrackChangesCommands(),
    registerRewriteCommands(),
    registerMenuCommands(),
    registerSurfaceCommands(),
  ]
})
afterAll(() => offs.forEach((off) => off()))
afterEach(() => cleanup())

const byMenu = (menu: string, groups?: readonly string[]) =>
  getCommands().filter((c) => c.menu?.id === menu && (!groups || groups.includes(c.menu.group)))

describe('the re-write gate over the real registry', () => {
  it('every Review command but the re-write ones is off (Track Changes, its review, comments)', () => {
    render(<NovelEditor />)
    act(() => setDocJSON({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A' }] }] }))
    const off = setActiveEditorSource(() => getEditor())
    const review = byMenu('review').filter((c) => !c.id.startsWith('rewrite.'))
    expect(review.length).toBeGreaterThan(5)
    for (const c of review) expect(rewriteCommandGate(c), c.id).toBe(false)
    // The re-write's own commands stay on (Close, New Version, Flip ...).
    for (const c of byMenu('review', ['rewrite-view'])) expect(rewriteCommandGate(c), c.id).toBe(true)
    off()
  })

  it('every View command about the pages is off; only Markup, Paper and Full Screen stay', () => {
    const ON = ['markup', 'paper', 'window']
    const view = byMenu('view')
    // A new View group must be placed: on (it shows the view's pages too) or off (the hidden manuscript's).
    expect([...new Set(view.map((c) => c.menu!.group))].sort()).toEqual(['layout', 'markup', 'navigation', 'panels', 'paper', 'spreads', 'window', 'zoom'])
    const pages = view.filter((c) => !ON.includes(c.menu!.group))
    expect(pages.length).toBeGreaterThan(10)
    for (const c of pages) expect(rewriteCommandGate(c), c.id).toBe(false)
    for (const c of view.filter((x) => ON.includes(x.menu!.group))) expect(rewriteCommandGate(c), c.id).toBe(true)
  })

  it('Find / Replace, Insert Footnote, Go to Page and the comment commands are off, by their real ids', () => {
    for (const id of ['find.open', 'edit.replace', 'footnote.insert', 'edit.go_to_page']) {
      const c = getCommand(id)
      expect(c, id).toBeDefined()
      expect(rewriteCommandGate(c!), id).toBe(false)
    }
    for (const c of getCommands().filter((x) => /comment/i.test(x.id))) expect(rewriteCommandGate(c), c.id).toBe(false)
  })

  it('setCommandGate / commandGateAllows: the gate decides while set, and is lifted once', () => {
    const save = getCommand('file.save') ?? getCommands().find((c) => c.menu?.id === 'file')!
    const find = getCommand('find.open')!
    const offGate = setCommandGate(rewriteCommandGate)
    expect(commandGateAllows(find)).toBe(false)
    expect(isCommandEnabled(find)).toBe(false)
    expect(commandGateAllows(save)).toBe(true)
    // A second gate replaces it; lifting the first one then does nothing.
    const offOther = setCommandGate(() => true)
    offGate()
    expect(commandGateAllows(find)).toBe(true)
    offOther()
    expect(commandGateAllows(find)).toBe(true)
  })
})

describe('useCommandGateAllows (controls that act without running a command)', () => {
  it('follows the gate: the status bar zoom can read whether View > Zoom In may run', async () => {
    const wait = () => act(async () => void (await new Promise((r) => setTimeout(r, COMMAND_STATE_DEBOUNCE_MS + 30))))
    const { result } = renderHook(() => useCommandGateAllows('pagination.zoomIn'))
    expect(result.current).toBe(true)
    const offGate = setCommandGate(rewriteCommandGate)
    await wait()
    expect(result.current).toBe(false)
    offGate()
    await wait()
    expect(result.current).toBe(true)
  })
})
