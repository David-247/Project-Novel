import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { getSchema, type Editor } from '@tiptap/core'
import { redo, undo } from '@tiptap/pm/history'
import { Slice } from '@tiptap/pm/model'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { createEditorExtensions, getEditor, NovelEditor, setActiveEditorSource, setDocJSON, type JSONContent } from '@/features/editor'
import { rejectAll, setTracking, TRACK_SKIP_META } from '@/features/track-changes'
import type { Command } from '@/shared/commands'
import { BULK_EDIT_META, REWRITE_BLOCK_ATTR } from '@/shared/rewrite'
import { useStore } from '@/shared/store'
import { alignBlocks } from './align'
import { passageProblem, passageRange, stripAnchors } from './anchor'
import { closeRewrite, rewritePassage, wireRewriteAnchors } from './commands'
import { rewriteCommandGate } from './gate'
import { RewriteHost } from './RewriteHost'
import { parseRewritesFile, serializeRewrite, withStatus } from './model'
import { __resetRewritesFileForTests } from './persistence'

/** Review fixes: anchors that must not be lost or duplicated, undo and comments on locked text, the command gate, alignment cost. */

beforeAll(() => {
  const rect = { x: 0, y: 0, top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, toJSON: () => ({}) }
  const emptyRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList
  Range.prototype.getClientRects ??= emptyRects
  Range.prototype.getBoundingClientRect ??= () => rect as DOMRect
  Element.prototype.getClientRects ??= emptyRects
  document.elementFromPoint ??= () => null
  wireRewriteAnchors()
})

const para = (t: string): JSONContent => ({ type: 'paragraph', content: [{ type: 'text', text: t }] })
const DOC: JSONContent[] = [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'One' }] }, para('Alpha line.'), para('Beta line.'), para('Gamma line.')]

function mount(): Editor {
  render(<NovelEditor />)
  act(() => setDocJSON({ type: 'doc', content: DOC }))
  return getEditor()!
}
function blockPos(ed: Editor, i: number): number {
  let pos = 0
  for (let k = 0; k < i; k++) pos += ed.state.doc.child(k).nodeSize
  return pos
}
const select = (ed: Editor, from: number, to = from) => ed.view.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, from, to)))
const rw = () => useStore.getState().rewrite
const anchorOf = (ed: Editor, i: number) => ed.state.doc.child(i).attrs[REWRITE_BLOCK_ATTR] as string | null
function rewrite(ed: Editor, a: number, b: number): string {
  select(ed, blockPos(ed, a) + 2, blockPos(ed, b) + 2)
  act(() => void rewritePassage())
  const id = rw().openId!
  act(() => closeRewrite())
  return id
}

beforeEach(() => {
  useStore.getState().rewriteActions.loaded([])
  __resetRewritesFileForTests()
  act(() => setTracking(false))
})
afterEach(() => cleanup())

describe('the anchor is never lost', () => {
  it('rejecting a tracked style change made before the re-write keeps the anchor', () => {
    const ed = mount()
    act(() => setTracking(true))
    select(ed, blockPos(ed, 1) + 2)
    act(() => void ed.commands.setTextAlign('center'))
    act(() => setTracking(false))
    expect(ed.state.doc.child(1).attrs.trackedStyleChange).not.toBeNull()
    const id = rewrite(ed, 1, 2)
    act(() => ed.view.dispatch(rejectAll(ed.state)!))
    expect(ed.state.doc.child(1).attrs.textAlign).toBeNull()
    expect(anchorOf(ed, 1)).toBe(id)
    expect(passageRange(ed.state.doc, id)).not.toBeNull()
  })

  it('a programmatic edit that drops the anchor from a passage block gets it back', () => {
    const ed = mount()
    const id = rewrite(ed, 1, 2)
    const pos = blockPos(ed, 2)
    act(() =>
      ed.view.dispatch(
        ed.state.tr.setNodeMarkup(pos, undefined, { ...ed.state.doc.child(2).attrs, [REWRITE_BLOCK_ATTR]: null }).setMeta(TRACK_SKIP_META, true),
      ),
    )
    expect(anchorOf(ed, 2)).toBe(id)
  })
})

describe('undo and the locked passage', () => {
  it('is never blocked: undoing a Replace All that touched the passage works, flags it, and older edits stay undoable', async () => {
    const ed = mount()
    // An older edit, before the re-write: alignment of the passage's paragraph.
    select(ed, blockPos(ed, 1) + 2)
    act(() => void ed.commands.setTextAlign('center'))
    const id = rewrite(ed, 1, 1)
    // A Replace All after the open, through the passage and the text after it.
    const tr = ed.state.tr
    for (const i of [3, 1]) tr.insertText('Omega', blockPos(ed, i) + 1, blockPos(ed, i) + 6)
    act(() => ed.view.dispatch(tr.setMeta(BULK_EDIT_META, true)))
    expect(ed.state.doc.child(1).textContent).toBe('Omega line.')
    expect(ed.state.doc.child(3).textContent).toBe('Omega line.')
    await act(async () => {
      useStore.getState().rewriteActions.changed(rw().rewrites.map((r) => ({ ...r, originalChanged: false })))
      await Promise.resolve()
    })
    // Undo the Replace All: both places come back; the re-write is flagged; a notice (not a refusal).
    await act(async () => {
      undo(ed.state, ed.view.dispatch)
      await Promise.resolve()
    })
    expect(ed.state.doc.child(1).textContent).toBe('Alpha line.')
    expect(ed.state.doc.child(3).textContent).toBe('Gamma line.')
    expect(rw().rewrites[0].originalChanged).toBe(true)
    expect(rw().notice).toMatchObject({ kind: 'undo', id })
    // The older edit inside the passage is undoable too; the anchor stays.
    await act(async () => {
      undo(ed.state, ed.view.dispatch)
      await Promise.resolve()
    })
    expect(ed.state.doc.child(1).attrs.textAlign).toBeNull()
    expect(anchorOf(ed, 1)).toBe(id)
    // And redo.
    act(() => void redo(ed.state, ed.view.dispatch))
    expect(ed.state.doc.child(1).attrs.textAlign).toBe('center')
  })

  it('an undo that removes the whole passage says so; the redo that puts it back re-anchors it', () => {
    const ed = mount()
    // An older event: two paragraphs inserted after Gamma.
    const end = ed.state.doc.content.size
    act(() => ed.view.dispatch(ed.state.tr.insert(end, [ed.schema.nodes.paragraph.create(null, ed.schema.text('Delta line.')), ed.schema.nodes.paragraph.create(null, ed.schema.text('Epsilon line.'))])))
    const id = rewrite(ed, 5, 5)
    expect(rw().problems).toEqual({})
    // Undo the insertion: the passage (Epsilon) is gone.
    act(() => void undo(ed.state, ed.view.dispatch))
    expect(ed.state.doc.childCount).toBe(4)
    expect(passageProblem(ed.state.doc, id)).toBe('missing')
    expect(rw().notice).toMatchObject({ kind: 'missing', id })
    expect(rw().problems).toEqual({ [id]: 'missing' })
    expect(rw().rewrites[0].originalChanged).toBe(true)
    // Redo: the blocks come back, the anchor with them (only on the passage's block); the notice goes.
    act(() => void redo(ed.state, ed.view.dispatch))
    expect(rw().notice).toBeNull()
    expect(anchorOf(ed, 4)).toBeNull()
    expect(anchorOf(ed, 5)).toBe(id)
    expect(passageRange(ed.state.doc, id)).not.toBeNull()
    expect(rw().problems).toEqual({})
    // The passage is locked again.
    const before = ed.state.doc
    select(ed, blockPos(ed, 5) + 2)
    act(() => ed.view.dispatch(ed.state.tr.insertText('X')))
    expect(ed.state.doc.eq(before)).toBe(true)
  })

  it('a block the user puts where a removed passage was is never anchored by a later undo', () => {
    const ed = mount()
    const emptyAtEnd = () => act(() => ed.view.dispatch(ed.state.tr.insert(ed.state.doc.content.size, ed.schema.nodes.paragraph.create())))
    // An older event inserts an empty paragraph; the re-write is on it; undo removes it.
    emptyAtEnd()
    const id = rewrite(ed, 4, 4)
    act(() => void undo(ed.state, ed.view.dispatch))
    expect(passageProblem(ed.state.doc, id)).toBe('missing')
    // The user puts an equal block (an empty paragraph) at that very spot, then edits elsewhere.
    emptyAtEnd()
    select(ed, blockPos(ed, 1) + 1)
    act(() => ed.view.dispatch(ed.state.tr.insertText('Q')))
    // Undo the unrelated edit: the user's block stays theirs.
    act(() => void undo(ed.state, ed.view.dispatch))
    expect(ed.state.doc.child(1).textContent).toBe('Alpha line.')
    expect(ed.state.doc.childCount).toBe(5)
    expect(anchorOf(ed, 4)).toBeNull()
    expect(rw().problems).toEqual({ [id]: 'missing' })
  })

  it('a removed passage of a re-write that is no longer open is forgotten: a redo brings back no lock', () => {
    const ed = mount()
    act(() => ed.view.dispatch(ed.state.tr.insert(ed.state.doc.content.size, ed.schema.nodes.paragraph.create(null, ed.schema.text('Delta line.')))))
    rewrite(ed, 4, 4)
    act(() => void undo(ed.state, ed.view.dispatch))
    act(() => useStore.getState().rewriteActions.changed(rw().rewrites.map((r) => ({ ...r, status: 'resolved' as const }))))
    expect(rw().problems).toEqual({})
    act(() => useStore.getState().rewriteActions.setNotice(null))
    act(() => void redo(ed.state, ed.view.dispatch))
    expect(ed.state.doc.child(4).textContent).toBe('Delta line.')
    expect(rw().notice).toBeNull()
    // Not locked: the re-write is resolved.
    select(ed, blockPos(ed, 4) + 1)
    act(() => ed.view.dispatch(ed.state.tr.insertText('Z')))
    expect(ed.state.doc.child(4).textContent).toBe('ZDelta line.')
  })

  it('the undo notice goes when the caret moves to or from a passage', () => {
    const ed = mount()
    const id = rewrite(ed, 1, 1)
    const tr = ed.state.tr.insertText('Omega', blockPos(ed, 1) + 1, blockPos(ed, 1) + 6).setMeta(BULK_EDIT_META, true)
    act(() => ed.view.dispatch(tr))
    act(() => void undo(ed.state, ed.view.dispatch))
    expect(rw().notice).toMatchObject({ kind: 'undo', id })
    render(<RewriteHost>{null}</RewriteHost>)
    // Into the passage, then out of it: the notice goes.
    act(() => select(ed, blockPos(ed, 1) + 2))
    act(() => select(ed, blockPos(ed, 3) + 2))
    expect(rw().notice).toBeNull()
  })

  it('typing from before the re-write is not merged with later edits (the history group is closed)', () => {
    const ed = mount()
    select(ed, blockPos(ed, 3) + 1)
    act(() => ed.view.dispatch(ed.state.tr.insertText('A')))
    rewrite(ed, 1, 1)
    select(ed, blockPos(ed, 3) + 2)
    act(() => ed.view.dispatch(ed.state.tr.insertText('B')))
    act(() => void undo(ed.state, ed.view.dispatch))
    expect(ed.state.doc.child(3).textContent).toBe('AGamma line.')
  })
})

describe('copies of passage blocks', () => {
  it('pasted and dropped slices lose the anchor (also the blocks in the middle of a drag-copy)', () => {
    const ed = mount()
    rewrite(ed, 1, 3)
    const slice = ed.state.doc.slice(blockPos(ed, 1) + 2, blockPos(ed, 3) + 3)
    const stripped = stripAnchors(slice)
    stripped.content.forEach((n) => expect(n.attrs[REWRITE_BLOCK_ATTR]).toBeNull())
    // Through the plugin's transformPasted, as a paste or a drop runs it.
    let out: Slice = slice
    ed.view.someProp('transformPasted', (f) => {
      out = f(out, ed.view, false)
    })
    out.content.forEach((n) => expect(n.attrs[REWRITE_BLOCK_ATTR]).toBeNull())
  })

  it('a passage in two runs is an error, never a span over the text between them', () => {
    const ed = mount()
    const id = rewrite(ed, 1, 1)
    const copy = ed.state.doc.child(1)
    // A copy that kept its anchor (inserted raw, as the old drag-copy did), after Gamma.
    act(() => ed.view.dispatch(ed.state.tr.insert(ed.state.doc.content.size, copy).setMeta('nvRewriteAllow', true)))
    expect(passageRange(ed.state.doc, id)).toBeNull()
    expect(passageProblem(ed.state.doc, id)).toBe('split')
  })
})

describe('comments on locked text', () => {
  it('a comment mark can be added to and removed from the passage; other marks cannot', () => {
    const ed = mount()
    rewrite(ed, 1, 1)
    const from = blockPos(ed, 1) + 1
    const comment = ed.schema.marks.comment.create({ id: 'c-1' })
    act(() => ed.view.dispatch(ed.state.tr.addMark(from, from + 5, comment)))
    expect(ed.state.doc.rangeHasMark(from, from + 5, ed.schema.marks.comment)).toBe(true)
    act(() => ed.view.dispatch(ed.state.tr.addMark(from, from + 5, ed.schema.marks.bold.create())))
    expect(ed.state.doc.rangeHasMark(from, from + 5, ed.schema.marks.bold)).toBe(false)
    act(() => ed.view.dispatch(ed.state.tr.removeMark(from, from + 5, ed.schema.marks.comment)))
    expect(ed.state.doc.rangeHasMark(from, from + 5, ed.schema.marks.comment)).toBe(false)
  })

  it('a refused edit at the passage edge (caret outside it) raises the notice', () => {
    const ed = mount()
    const id = rewrite(ed, 1, 1)
    select(ed, blockPos(ed, 2) + 1)
    act(() => ed.view.dispatch(ed.state.tr.delete(blockPos(ed, 2) - 1, blockPos(ed, 2) + 1)))
    expect(rw().notice).toMatchObject({ kind: 'locked', id })
    expect(rw().caretIn).toBeNull()
  })
})

describe('re-write records', () => {
  it('Re-write Passage… adds no record when the anchor could not be written', () => {
    const ed = mount()
    // Another plugin refuses the anchor transaction.
    const key = new PluginKey('refuseAnchors')
    ed.registerPlugin(new Plugin({ key, filterTransaction: (tr) => !tr.getMeta('nvRewriteAllow') }))
    select(ed, blockPos(ed, 1) + 2)
    act(() => void rewritePassage())
    expect(rw().rewrites).toEqual([])
    expect(rw().openId).toBeNull()
    expect(anchorOf(ed, 1)).toBeNull()
    ed.unregisterPlugin(key)
  })

  it('an unknown status is written back until a status is set', () => {
    const raw = {
      id: 'rw-1',
      anchor: 'rw-1',
      createdAt: '2026-11-05T09:00:00.000Z',
      original: { type: 'doc', content: [para('A')] },
      versions: [{ id: 'v-1', name: 'V', doc: { type: 'doc', content: [para('A')] }, updatedAt: '2026-11-05T09:00:00.000Z' }],
      status: 'archived',
    }
    const [r] = parseRewritesFile({ version: 1, rewrites: [raw] }).rewrites
    expect(r.status).toBe('resolved')
    expect(serializeRewrite(r).status).toBe('archived')
    expect(serializeRewrite(withStatus(r, 'resolved')).status).toBe('resolved')
    expect(serializeRewrite(withStatus(r, 'open')).status).toBe('open')
  })
})

describe('commands while the view is open (the gate)', () => {
  const cmd = (id: string, menu?: Command['menu'], guard?: Command['guard']): Command => ({ id, label: id, description: 'x.', menu, guard, run: () => {} })

  it('text commands follow the active editor; manuscript-wide commands are off', () => {
    const ed = mount()
    const bold = cmd('toolbar.bold', { id: 'format', group: 'marks', order: 1 })
    let focused: Editor | null = ed
    const off = setActiveEditorSource(() => focused)
    expect(rewriteCommandGate(bold)).toBe(true)
    focused = null
    expect(rewriteCommandGate(bold)).toBe(false)
    expect(rewriteCommandGate(cmd('edit.copy', { id: 'edit', group: 'clipboard', order: 1 }))).toBe(true)
    for (const id of ['find.open', 'edit.replace', 'review.track', 'comment.new', 'footnote.insert', 'edit.go_to_page']) expect(rewriteCommandGate(cmd(id)), id).toBe(false)
    expect(rewriteCommandGate(cmd('view.zoomIn', { id: 'view', group: 'zoom', order: 1 }))).toBe(false)
    expect(rewriteCommandGate(cmd('file.save', { id: 'file', group: 'save', order: 1 }))).toBe(true)
    // A text field in the view (the version name): Edit history / clipboard act on it.
    const input = document.createElement('input')
    document.body.append(input)
    input.focus()
    expect(rewriteCommandGate(cmd('history.undo', { id: 'edit', group: 'history', order: 1 }))).toBe(true)
    expect(rewriteCommandGate(cmd('edit.paste', { id: 'edit', group: 'clipboard', order: 1 }))).toBe(true)
    expect(rewriteCommandGate(bold)).toBe(false)
    input.remove()
    off()
  })
})

describe('alignment at chapter scale', () => {
  it('250 paragraphs with an edit, an insertion and a removal: aligned in well under a frame', () => {
    const schema = getSchema(createEditorExtensions({ detached: true }))
    const words = 'the river quiet lantern stone window garden letter morning shadow silver harbor whisper meadow candle thunder'.split(' ')
    const paras = Array.from({ length: 250 }, (_, i) => Array.from({ length: 32 }, (_, k) => words[(i * 7 + k * 3) % words.length]).join(' ') + ` ${i}.`)
    const doc = (list: string[]) => schema.nodeFromJSON({ type: 'doc', content: list.map(para) })
    const left = doc(paras)
    const edited = paras.slice()
    edited[40] = edited[40].replace('river', 'stream')
    edited.splice(120, 0, 'A wholly new paragraph that shares nothing with its neighbours at all.')
    edited.splice(201, 1)
    const right = doc(edited)
    const t0 = performance.now()
    const rows = alignBlocks(left, right)
    const ms = performance.now() - t0
    expect(rows.filter((r) => r.kind === 'changed').map((r) => [r.left, r.right])).toEqual([[40, 40]])
    expect(rows.filter((r) => r.kind === 'added').map((r) => r.right)).toEqual([120])
    expect(rows.filter((r) => r.kind === 'removed').map((r) => r.left)).toEqual([200])
    expect(rows).toHaveLength(251)
    expect(ms).toBeLessThan(50)
  })
})
