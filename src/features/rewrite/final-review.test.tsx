import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Editor } from '@tiptap/core'
import { redo, undo } from '@tiptap/pm/history'
import { TextSelection } from '@tiptap/pm/state'
import { Decoration } from '@tiptap/pm/view'
import { createStyle, deleteStyle, getEditor, NovelEditor, setDocJSON, type JSONContent } from '@/features/editor'
import { listChanges, setTracking } from '@/features/track-changes'
import type { DocNodeJSON } from '@/shared/document'
import { REWRITE_BLOCK_ATTR } from '@/shared/rewrite'
import { useStore } from '@/shared/store'
import { rewriteAnchorKey } from './anchor'
import { discardRewrite, keepVersionNow, reopenRewrite } from './choice'
import { closeRewrite, getRewrite, openRewrite, rewritePassage, wireRewriteAnchors } from './commands'
import { __resetRewritesFileForTests } from './persistence'
import { __resetRemovedRewritesForTests } from './step'

/** Phase 3 final review, re-write area: regression tests for the fixes. */

beforeAll(() => {
  const rect = { x: 0, y: 0, top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, toJSON: () => ({}) }
  const emptyRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList
  Range.prototype.getClientRects ??= emptyRects
  Range.prototype.getBoundingClientRect ??= () => rect as DOMRect
  Element.prototype.getClientRects ??= emptyRects
  document.elementFromPoint ??= () => null
  wireRewriteAnchors()
})

const text = (t: string): JSONContent => ({ type: 'text', text: t })
const para = (t: string, attrs?: Record<string, unknown>): JSONContent => ({ type: 'paragraph', ...(attrs ? { attrs } : {}), content: [text(t)] })
const title = (t: string): JSONContent => ({ type: 'heading', attrs: { level: 1 }, content: [text(t)] })
const DOC: JSONContent[] = [title('One'), para('The rain came at dusk.'), para('She closed the window.'), para('Nobody spoke.'), title('Two'), para('Water everywhere.')]

function mount(content: JSONContent[] = DOC): Editor {
  render(<NovelEditor />)
  act(() => setDocJSON({ type: 'doc', content }))
  return getEditor()!
}
function blockPos(ed: Editor, i: number): number {
  let pos = 0
  for (let k = 0; k < i; k++) pos += ed.state.doc.child(k).nodeSize
  return pos
}
const select = (ed: Editor, from: number, to = from) => ed.view.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, from, to)))
const rw = () => useStore.getState().rewrite
const texts = (ed: Editor) => {
  const out: string[] = []
  ed.state.doc.forEach((n) => out.push(n.textContent))
  return out
}
function rewrite(ed: Editor, a: number, b: number, blocks?: JSONContent[]): [string, string] {
  select(ed, blockPos(ed, a) + 2, blockPos(ed, b) + 2)
  act(() => void rewritePassage())
  const id = rw().openId!
  act(() => closeRewrite())
  if (blocks) setVersion(id, blocks)
  return [id, getRewrite(id)!.versions[0].id]
}
function setVersion(id: string, blocks: JSONContent[]) {
  const doc = { type: 'doc', content: blocks } as DocNodeJSON
  act(() => useStore.getState().rewriteActions.changed(rw().rewrites.map((x) => (x.id === id ? { ...x, versions: [{ ...x.versions[0], doc }, ...x.versions.slice(1)] } : x))))
}
const run = (ed: Editor, cmd: typeof undo) => act(() => void cmd(ed.state, ed.view.dispatch))
/** Every styleId in a passage doc (or manuscript JSON). */
const styleIds = (json: unknown): string[] => {
  const out: string[] = []
  const walk = (j: { attrs?: Record<string, unknown>; content?: unknown[] }) => {
    if (typeof j.attrs?.styleId === 'string') out.push(j.attrs.styleId)
    j.content?.forEach((c) => walk(c as typeof j))
  }
  walk(json as never)
  return out
}

beforeEach(() => {
  useStore.getState().rewriteActions.loaded([])
  useStore.getState().bookActions.resetBook()
  __resetRewritesFileForTests()
  __resetRemovedRewritesForTests()
  act(() => setTracking(false))
})
afterEach(() => cleanup())

describe('#1 Delete Style while a re-write is open', () => {
  it('re-maps the locked passage, the original, every version and the kept copy; Keep never brings the style back', () => {
    const ed = mount()
    let letter = ''
    act(() => void (letter = createStyle('block-quote', 'Letter')))
    act(() => void ed.commands.setTextSelection(blockPos(ed, 2) + 2))
    act(() => void ed.commands.setBlockStyle(letter))
    expect(ed.state.doc.child(2).attrs.styleId).toBe(letter)
    // Open (and closed: the lock applies while it is open, shown or not), with a second version.
    const [id] = rewrite(ed, 1, 2)
    setVersion(id, [para('The rain came at night.'), para('She shut the window.', { styleId: letter })])
    expect(styleIds(getRewrite(id)!.original)).toEqual([letter])
    act(() => void deleteStyle(letter))
    // The manuscript, behind the lock, follows (no "being re-written" refusal).
    expect(ed.state.doc.child(2).attrs.styleId).toBe('block-quote')
    expect(rw().notice?.kind).not.toBe('locked')
    const r = getRewrite(id)!
    expect(styleIds(r.original)).toEqual(['block-quote'])
    expect(r.versions.flatMap((v) => styleIds(v.doc))).toEqual(['block-quote'])
    act(() => void keepVersionNow(r.versions[0].id, id))
    let used: string[] = []
    ed.state.doc.forEach((n) => void (used = used.concat(styleIds(n.toJSON()))))
    expect(used).not.toContain(letter)
    expect(styleIds(getRewrite(id)!.kept)).toEqual(['block-quote'])
  })

  it('re-maps a resolved re-write too (Reopen and its kept copy)', () => {
    const ed = mount()
    let letter = ''
    act(() => void (letter = createStyle('block-quote', 'Letter')))
    const [id, vid] = rewrite(ed, 1, 1, [para('The rain came at night.', { styleId: letter })])
    act(() => void keepVersionNow(vid, id))
    expect(styleIds(getRewrite(id)!.kept)).toEqual([letter])
    act(() => void deleteStyle(letter))
    expect(styleIds(getRewrite(id)!.kept)).toEqual(['block-quote'])
    expect(styleIds(getRewrite(id)!.versions[0].doc)).toEqual(['block-quote'])
  })

  it('under Track Changes the remap is not recorded, and the passage is not refused', () => {
    const ed = mount()
    let letter = ''
    act(() => void (letter = createStyle('block-quote', 'Letter')))
    act(() => void ed.commands.setTextSelection(blockPos(ed, 1) + 2))
    act(() => void ed.commands.setBlockStyle(letter))
    rewrite(ed, 1, 1)
    act(() => setTracking(true))
    act(() => void deleteStyle(letter))
    expect(ed.state.doc.child(1).attrs.styleId).toBe('block-quote')
    expect(listChanges(ed.state.doc)).toEqual([])
  })
})

describe('#3 Discard, undo, edit, redo, undo', () => {
  it('keeps the version edits made after the undo', () => {
    const ed = mount()
    const [id] = rewrite(ed, 1, 1, [para('First draft.')])
    act(() => void discardRewrite(id))
    run(ed, undo)
    expect(getRewrite(id)).toBeDefined()
    // Work on the versions (the revision never touches the manuscript history).
    setVersion(id, [para('Second draft, much better.')])
    run(ed, redo)
    expect(getRewrite(id)).toBeUndefined()
    run(ed, undo)
    expect(getRewrite(id)!.versions[0].doc.content![0].content![0].text).toBe('Second draft, much better.')
  })
})

describe('#4 Find & Replace while a re-write is open', () => {
  it('opening a re-write closes the Find panel; it cannot stay open over the view', () => {
    const ed = mount()
    act(() => useStore.getState().findActions.openPanel('rain'))
    expect(useStore.getState().find.open).toBe(true)
    select(ed, blockPos(ed, 1) + 2)
    act(() => void rewritePassage())
    expect(rw().openId).not.toBeNull()
    expect(useStore.getState().find.open).toBe(false)
  })
})

describe('#11 Reopen', () => {
  it('a Reopen that finds nothing leaves the open view open', () => {
    const ed = mount()
    const [gone, gv] = rewrite(ed, 3, 3, [para('Nobody said a word.')])
    act(() => void keepVersionNow(gv, gone))
    // The kept text is edited away.
    const at = blockPos(ed, 3) + 1
    act(() => ed.view.dispatch(ed.state.tr.insertText('Totally different words here', at, at + ed.state.doc.child(3).content.size)))
    const [other] = rewrite(ed, 1, 1)
    act(() => void openRewrite(other))
    expect(rw().openId).toBe(other)
    act(() => void reopenRewrite(gone))
    expect(rw().notice?.kind).toBe('notFound')
    expect(rw().openId).toBe(other)
  })
})

describe('#12 typing before an open passage', () => {
  it('maps the passage decorations instead of rebuilding them on every keystroke', () => {
    const ed = mount([para('Before.'), ...Array.from({ length: 30 }, (_, i) => para(`Passage block ${i}.`)), para('After.')])
    const [id] = rewrite(ed, 1, 30)
    const spy = vi.spyOn(Decoration, 'node')
    for (let i = 0; i < 5; i++) {
      const tr = ed.state.tr.insertText('x', 2)
      act(() => ed.view.dispatch(tr))
    }
    // (Other plugins make node decorations of their own: only the lock's count.)
    const locked = spy.mock.calls.filter((c) => String((c[2] as { class?: string } | undefined)?.class ?? '').includes('nv-rw-locked'))
    expect(locked).toHaveLength(0)
    spy.mockRestore()
    // Still right: the decorations sit on the passage's blocks where they are now.
    const st = rewriteAnchorKey.getState(ed.state)!
    expect(st.ranges).toEqual([{ id, from: blockPos(ed, 1), to: blockPos(ed, 31) }])
    expect(st.decorations.find(blockPos(ed, 1), blockPos(ed, 31))).toHaveLength(30)
    expect(st.decorations.find(0, blockPos(ed, 1) - 1)).toHaveLength(0)
    expect(texts(ed)[0]).toBe('Bxxxxxefore.')
  })
})

describe('#16 a tracked Keep undone with Track Changes still on', () => {
  it('one undo through a real dispatch restores the original and the open re-write; nothing tracked is left', () => {
    const ed = mount()
    const [id, vid] = rewrite(ed, 1, 1, [para('The rain came at night.')])
    act(() => setTracking(true))
    act(() => void keepVersionNow(vid, id))
    expect(listChanges(ed.state.doc).length).toBeGreaterThan(0)
    expect(getRewrite(id)!.status).toBe('resolved')
    // Mod-z with tracking on: the undo is never recorded as a change of its own.
    run(ed, undo)
    expect(texts(ed)[1]).toBe('The rain came at dusk.')
    expect(listChanges(ed.state.doc)).toEqual([])
    expect(getRewrite(id)!.status).toBe('open')
    expect(ed.state.doc.child(1).attrs[REWRITE_BLOCK_ATTR]).toBe(getRewrite(id)!.anchor)
    run(ed, redo)
    expect(getRewrite(id)!.status).toBe('resolved')
    expect(listChanges(ed.state.doc).length).toBeGreaterThan(0)
  })
})
