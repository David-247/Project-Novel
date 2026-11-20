import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { JSONContent } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore, type PageInfo } from '@/shared/store'
import { TooltipProvider } from '@/shared/ui'
import { backend } from '@/test-utils/fake-tauri'

vi.mock('@tauri-apps/api/core', async () => (await import('@/test-utils/fake-tauri')).coreModule)

import { getEditor, NovelEditor, setDocJSON, openEditorContextMenu } from '@/features/editor'
import { __resetIgnoredForTests } from './dictionary'
import {
  __resetSpellcheckCacheForTests,
  addWord,
  createSpellcheckExtension,
  getFindingsInRange,
  registerSpellcheckMenu,
  SPELL_CHECK_DEBOUNCE_MS,
} from './index'
import { getUnderlineSpecsForTests } from './extension'

const stamp = { id: 'c1', author: 'Ann', date: '2026-01-01T00:00:00.000Z', authorColor: null }
const t = (text: string, marks?: JSONContent['marks']): JSONContent => ({ type: 'text', text, ...(marks ? { marks } : {}) })
const p = (...content: JSONContent[]): JSONContent => ({ type: 'paragraph', content })
const doc = (...content: JSONContent[]): JSONContent => ({ type: 'doc', content })

let offMenu: () => void = () => {}

beforeAll(() => {
  // jsdom lacks the layout APIs ProseMirror uses to scroll and to place the caret.
  const rect = { x: 0, y: 0, top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, toJSON: () => ({}) }
  const emptyRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList
  Range.prototype.getClientRects ??= emptyRects
  Range.prototype.getBoundingClientRect ??= () => rect as DOMRect
  Element.prototype.getClientRects ??= emptyRects
  document.elementFromPoint ??= () => null
  // Radix positions a context menu from a DOMRect of the pointer.
  if (!('fromRect' in DOMRect)) (DOMRect as unknown as { fromRect: (r: Partial<DOMRect>) => DOMRect }).fromRect = (r) => new DOMRect(r.x, r.y, r.width, r.height)
})

beforeEach(() => {
  // shouldAdvanceTime: Testing Library's findBy* polls with setTimeout.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true })
  backend.reset()
  __resetSpellcheckCacheForTests()
  __resetIgnoredForTests()
  useStore.getState().preferencesActions.set('spellcheck', { enabled: true, words: [] })
  useStore.getState().spellcheckActions.loadProjectWords([])
  useStore.getState().layoutActions.resetLayout()
  offMenu = registerSpellcheckMenu()
})

afterEach(async () => {
  offMenu()
  cleanup()
  // Tiptap destroys an unmounted editor from a timeout: let it, so no check of this test runs in the next.
  await act(() => vi.advanceTimersByTimeAsync(SPELL_CHECK_DEBOUNCE_MS * 2))
  setDocJSON({ type: 'doc', content: [{ type: 'paragraph' }] })
  vi.useRealTimers()
})

function mount(content: JSONContent) {
  render(
    <TooltipProvider>
      <NovelEditor extensions={[createSpellcheckExtension()]} />
    </TooltipProvider>,
  )
  act(() => setDocJSON(content))
  const ed = getEditor()
  if (!ed) throw new Error('editor not mounted')
  return ed
}

/** Let the debounce run out and the (fake) engine answer. */
async function idle() {
  await act(() => vi.advanceTimersByTimeAsync(SPELL_CHECK_DEBOUNCE_MS + 10))
  await act(() => vi.advanceTimersByTimeAsync(0))
}

const underlines = (cls = 'spell-error') => [...document.querySelectorAll(`.novel-editor-content .${cls}`)].map((e) => e.textContent)

function type(text: string) {
  const ed = getEditor()!
  for (const ch of text) act(() => ed.view.dispatch(ed.state.tr.insertText(ch)))
}

describe('spell check underlines', () => {
  it('typing "teh " underlines exactly "teh" once the typing pauses, never in the keystroke', async () => {
    const ed = mount(doc(p(t('I saw '))))
    await idle()
    act(() => ed.commands.setTextSelection(ed.state.doc.content.size - 1))
    backend.spell.calls.length = 0
    type('teh ')
    // Nothing is checked while typing: the debounce has not run out.
    expect(backend.spell.calls).toHaveLength(0)
    await act(() => vi.advanceTimersByTimeAsync(SPELL_CHECK_DEBOUNCE_MS - 50))
    expect(backend.spell.calls).toHaveLength(0)
    expect(underlines()).toEqual([])
    await idle()
    expect(backend.spell.calls).toHaveLength(1)
    expect(underlines()).toEqual(['teh'])
    const at = ed.state.doc.textContent.indexOf('teh') + 1
    expect(getFindingsInRange(at, at + 3)).toMatchObject([{ from: at, to: at + 3, kind: 'spelling', suggestions: ['the'] }])
  })

  it('does not flag the word still being typed at the caret', async () => {
    const ed = mount(doc(p(t('I saw '))))
    await idle()
    act(() => ed.commands.setTextSelection(ed.state.doc.content.size - 1))
    type('teh')
    await idle()
    expect(underlines()).toEqual([])
    // Moving away shows it.
    act(() => ed.commands.setTextSelection(1))
    await idle()
    expect(underlines()).toEqual(['teh'])
  })

  it('underlines the right characters after curly quotes, accents and emoji (Review Focus 1)', async () => {
    mount(doc(p(t('“Aelinor’s” teh')), p(t('Zoë—said \u{1F600} teh, café teh'))))
    await idle()
    expect(underlines()).toEqual(['teh', 'teh', 'teh'])
  })

  it('checks the text as No Markup shows it: tracked-deleted text is neither sent nor underlined', async () => {
    const del = [{ type: 'deletion', attrs: stamp }]
    mount(doc(p(t('One '), t('teh ', del), t('two teh'))))
    await idle()
    expect(backend.spell.calls.flatMap((c) => c.blocks.map((b) => b.text))).toEqual(['One two teh'])
    expect(underlines()).toEqual(['teh'])
    const el = document.querySelector('.novel-editor-content .spell-error')!
    expect(el.closest('del, [data-deletion], .nv-deletion')).toBeNull()
  })

  it('maps a finding after a footnote reference onto the right word', async () => {
    mount(doc(p(t('A road'), { type: 'footnote', content: [t('Smith teh.')] }, t(' and teh end'))))
    await idle()
    expect(underlines()).toEqual(['teh'])
  })

  it('checks only the blocks on the pages in view (and one page either side), in chunks of at most 200', async () => {
    const many = Array.from({ length: 500 }, (_, i) => p(t(`Line ${i} teh`)))
    const ed = mount(doc(...many))
    let at = 0
    const pages: PageInfo[] = []
    // Five pages of 100 blocks; page 2 is in view.
    for (let k = 0; k < 5; k++) {
      const from = at
      for (let i = k * 100; i < (k + 1) * 100; i++) at += ed.state.doc.child(i).nodeSize
      pages.push({ index: k, side: 'recto' as const, from, to: at, isBlank: false, startsBlockType: 'paragraph', chapterIndex: 0 })
    }
    act(() => {
      useStore.getState().layoutActions.setPages(pages)
      useStore.getState().layoutActions.setVisibleSpread({ index: 2, first: 2, last: 2 })
    })
    backend.spell.calls.length = 0
    __resetSpellcheckCacheForTests()
    await idle()
    await idle()
    const sent = backend.spell.calls.flatMap((c) => c.blocks.map((b) => b.text))
    expect(backend.spell.calls.length).toBeGreaterThan(1)
    expect(backend.spell.calls.every((c) => c.blocks.length <= 200)).toBe(true)
    expect(sent).toContain('Line 100 teh')
    expect(sent).toContain('Line 399 teh')
    expect(sent).not.toContain('Line 99 teh')
    expect(sent).not.toContain('Line 400 teh')
  })

  it('View > Spelling & Grammar off removes every underline; on brings them back', async () => {
    mount(doc(p(t('teh one'))))
    await idle()
    expect(underlines()).toEqual(['teh'])
    act(() => useStore.getState().preferencesActions.set('spellcheck', { ...useStore.getState().preferences.spellcheck, enabled: false }))
    expect(underlines()).toEqual([])
    act(() => useStore.getState().preferencesActions.set('spellcheck', { ...useStore.getState().preferences.spellcheck, enabled: true }))
    await idle()
    expect(underlines()).toEqual(['teh'])
  })

  it('marks grammar findings with grammar-error', async () => {
    backend.spell.grammar.set('a apple', ['an apple'])
    mount(doc(p(t('She ate a apple.'))))
    await idle()
    expect(underlines('grammar-error')).toEqual(['a apple'])
    expect(underlines()).toEqual([])
  })
})

describe('the editor context menu', () => {
  async function openAt(word: string, nth = 0) {
    const ed = getEditor()!
    let from = -1
    ed.state.doc.descendants((n, pos) => {
      if (!n.isText) return
      let i = -1
      while ((i = n.text!.indexOf(word, i + 1)) >= 0) if (from < 0 && nth-- === 0) from = pos + i
    })
    act(() => {
      openEditorContextMenu({ pos: from + 1, x: 10, y: 10 })
    })
    return screen.findByRole('menu')
  }

  it('lists the suggestions first (Word), then Ignore Once and Add to Dictionary, each with a tooltip id', async () => {
    mount(doc(p(t('I saw teh dog.'))))
    await idle()
    const menu = await openAt('teh')
    const items = [...menu.querySelectorAll('[role="menuitem"]')]
    const names = items.map((i) => i.textContent?.trim())
    expect(names.slice(0, 3)).toEqual(['the', 'Ignore Once', 'Add to Dictionary'])
    for (const i of items) expect(i.getAttribute('data-control-id')).toBeTruthy()
  })

  it('choosing a suggestion replaces the word in one undoable step', async () => {
    const ed = mount(doc(p(t('I saw teh dog.'))))
    await idle()
    await openAt('teh')
    fireEvent.click(screen.getByRole('menuitem', { name: 'the' }))
    expect(ed.state.doc.textContent).toBe('I saw the dog.')
    expect(underlines()).toEqual([])
    act(() => {
      ed.commands.undo()
    })
    expect(ed.state.doc.textContent).toBe('I saw teh dog.')
  })

  it('Add to Dictionary clears the word everywhere, also off the pages in view', async () => {
    const ed = mount(doc(p(t('teh one')), p(t('two teh'))))
    await idle()
    expect(underlines()).toEqual(['teh', 'teh'])
    // Only the first paragraph in view now.
    const first = ed.state.doc.child(0).nodeSize
    act(() => {
      useStore.getState().layoutActions.setPages([
        { index: 0, side: 'recto', from: 0, to: first, isBlank: false, startsBlockType: 'paragraph', chapterIndex: 0 },
        { index: 1, side: 'verso', from: first, to: ed.state.doc.content.size, isBlank: false, startsBlockType: 'paragraph', chapterIndex: 0 },
        { index: 2, side: 'recto', from: ed.state.doc.content.size, to: ed.state.doc.content.size, isBlank: true, startsBlockType: null, chapterIndex: 0 },
        { index: 3, side: 'verso', from: ed.state.doc.content.size, to: ed.state.doc.content.size, isBlank: true, startsBlockType: null, chapterIndex: 0 },
      ])
      useStore.getState().layoutActions.setVisibleSpread({ index: 0, first: 0, last: 0 })
    })
    await openAt('teh')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add to Dictionary' }))
    expect(useStore.getState().preferences.spellcheck.words).toEqual(['teh'])
    expect(underlines()).toEqual([])
    await idle()
    expect(underlines()).toEqual([])
  })

  it('a word split by a tracked deletion is underlined across it, but its suggestions are not offered as replacements', async () => {
    const del = [{ type: 'deletion', attrs: stamp }]
    const ed = mount(doc(p(t('I saw te'), t('x', del), t('h dog.'))))
    await idle()
    const found = getFindingsInRange(0, ed.state.doc.content.size)
    expect(found).toHaveLength(1)
    expect(ed.state.doc.textBetween(found[0].from, found[0].to)).toBe('texh')
    await openAt('te')
    expect(screen.getByRole('menuitem', { name: 'the' })).toHaveAttribute('data-disabled')
    expect(screen.getByRole('menuitem', { name: 'Ignore Once' })).not.toHaveAttribute('data-disabled')
  })

  /** Run a recheck (a page turn) while the menu stays open. */
  async function recheck() {
    act(() => useStore.getState().layoutActions.setVisibleSpread({ index: 1, first: 1, last: 1 }))
    await idle()
    act(() => useStore.getState().layoutActions.setVisibleSpread({ index: 0, first: 0, last: 0 }))
    await idle()
  }

  it('REGRESSION: a recheck while the menu is open does not break its suggestion', async () => {
    const ed = mount(doc(p(t('I saw teh dog.'))))
    await idle()
    await openAt('teh')
    const calls = backend.spell.calls.length
    __resetSpellcheckCacheForTests() // the recheck really answers again (new Finding objects)
    await recheck()
    expect(backend.spell.calls.length).toBeGreaterThan(calls)
    fireEvent.click(screen.getByRole('menuitem', { name: 'the' }))
    expect(ed.state.doc.textContent).toBe('I saw the dog.')
    expect(underlines()).toEqual([])
  })

  it('REGRESSION: a recheck while the menu is open does not break Ignore Once', async () => {
    mount(doc(p(t('I saw teh dog.'))))
    await idle()
    await openAt('teh')
    __resetSpellcheckCacheForTests()
    await recheck()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Ignore Once' }))
    expect(underlines()).toEqual([])
  })

  it('a recheck with unchanged findings keeps the same decorations (the block is not redrawn)', async () => {
    const ed = mount(doc(p(t('I saw teh dog.')), p(t('More teh.'))))
    await idle()
    const specs = () => getUnderlineSpecsForTests(ed.state)
    const before = specs()
    expect(before).toHaveLength(2)
    const el = document.querySelector('.novel-editor-content .spell-error')
    __resetSpellcheckCacheForTests()
    await recheck()
    expect(specs()).toHaveLength(2)
    specs().forEach((s, i) => expect(s).toBe(before[i]))
    // The same DOM node: ProseMirror did not redraw the underlined text.
    expect(document.querySelector('.novel-editor-content .spell-error')).toBe(el)
  })

  it('Ignore Once hides that one finding only', async () => {
    mount(doc(p(t('teh one')), p(t('two teh!'))))
    await idle()
    await openAt('teh')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Ignore Once' }))
    expect(underlines()).toEqual(['teh'])
    await idle()
    expect(underlines()).toEqual(['teh'])
  })

  it('Shift+F10 opens the menu at the caret with the keyboard focus in it; Escape returns to the text', async () => {
    const ed = mount(doc(p(t('I saw teh dog.'))))
    await idle()
    act(() => {
      ed.view.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, 8)))
      ed.view.focus()
    })
    fireEvent.keyDown(ed.view.dom, { key: 'F10', shiftKey: true })
    const menu = await screen.findByRole('menu')
    expect(menu.contains(document.activeElement)).toBe(true)
    expect(screen.getByRole('menuitem', { name: 'the' })).toBeInTheDocument()
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('the Menu key opens it too', async () => {
    const ed = mount(doc(p(t('I saw teh dog.'))))
    await idle()
    act(() => ed.view.focus())
    fireEvent.keyDown(ed.view.dom, { key: 'ContextMenu' })
    expect(await screen.findByRole('menu')).toBeInTheDocument()
  })

  it('adding a word through the slice clears its underlines too', async () => {
    mount(doc(p(t('teh one'))))
    await idle()
    act(() => {
      addWord('Teh', 'project')
    })
    expect(underlines()).toEqual([])
  })
})
