import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Editor } from '@tiptap/core'
import { redo, undo } from '@tiptap/pm/history'
import { TextSelection } from '@tiptap/pm/state'
import { getEditor, NovelEditor, setDocJSON, type JSONContent } from '@/features/editor'
import { acceptAll, rejectAll, setTracking } from '@/features/track-changes'
import type { DocNodeJSON } from '@/shared/document'
import { BULK_EDIT_META, REWRITE_BLOCK_ATTR } from '@/shared/rewrite'
import { useStore, type RewriteRecord } from '@/shared/store'
import { passageRange } from './anchor'
import { discardRewrite, keepOriginal, keepVersion, keepVersionNow, locatePassage, reopenRewrite, setRewriteConfirm } from './choice'
import { closeRewrite, getRewrite, rewritePassage, wireRewriteAnchors } from './commands'
import { parseRewritesFile, serializeRewrite } from './model'
import { __resetRewritesFileForTests } from './persistence'
import { RewriteStateStep } from './step'

beforeAll(() => {
  const rect = { x: 0, y: 0, top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, toJSON: () => ({}) }
  const emptyRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList
  Range.prototype.getClientRects ??= emptyRects
  Range.prototype.getBoundingClientRect ??= () => rect as DOMRect
  Element.prototype.getClientRects ??= emptyRects
  document.elementFromPoint ??= () => null
  wireRewriteAnchors()
})

const text = (t: string, marks?: JSONContent['marks']): JSONContent => ({ type: 'text', text: t, ...(marks ? { marks } : {}) })
const para = (...c: (string | JSONContent)[]): JSONContent => ({ type: 'paragraph', content: c.map((x) => (typeof x === 'string' ? text(x) : x)) })
const title = (t: string): JSONContent => ({ type: 'heading', attrs: { level: 1 }, content: [text(t)] })
const footnote = (t: string): JSONContent => ({ type: 'footnote', content: [text(t)] })

const DOC: JSONContent[] = [
  title('One'),
  para('The rain came at dusk, soft at first.'),
  para('She closed the window', footnote('A note.'), ' and listened.'),
  para('Nobody spoke.'),
  title('Two'),
  para('Water everywhere.'),
]

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
const anchors = (ed: Editor) => {
  const out: (string | null)[] = []
  ed.state.doc.forEach((n) => out.push((n.attrs[REWRITE_BLOCK_ATTR] as string | null) ?? null))
  return out
}

/** Re-write blocks a..b; the first version's passage becomes `blocks`. Returns [rewrite id, version id]. */
function rewrite(ed: Editor, a: number, b: number, blocks?: JSONContent[]): [string, string] {
  select(ed, blockPos(ed, a) + 2, blockPos(ed, b) + 2)
  act(() => void rewritePassage())
  const id = rw().openId!
  act(() => closeRewrite())
  const r = getRewrite(id)!
  if (blocks) {
    const doc = { type: 'doc', content: blocks } as DocNodeJSON
    act(() => useStore.getState().rewriteActions.changed(rw().rewrites.map((x) => (x.id === id ? { ...x, versions: [{ ...x.versions[0], doc }] } : x))))
  }
  return [id, r.versions[0].id]
}
const run = (ed: Editor, cmd: typeof undo) => act(() => void cmd(ed.state, ed.view.dispatch))

beforeEach(() => {
  useStore.getState().rewriteActions.loaded([])
  __resetRewritesFileForTests()
  act(() => setTracking(false))
  setRewriteConfirm(null)
})
afterEach(() => cleanup())

describe('Keep This Version', () => {
  it('replaces the passage, resolves the re-write; one undo restores the text and the open re-write with all its versions; redo again', () => {
    const ed = mount()
    const [id, vid] = rewrite(ed, 1, 1, [para('The rain came at night, hard from the start.')])
    const versions = getRewrite(id)!.versions
    act(() => void keepVersionNow(vid, id))
    expect(texts(ed)[1]).toBe('The rain came at night, hard from the start.')
    expect(getRewrite(id)).toMatchObject({ status: 'resolved', choice: vid })
    expect(getRewrite(id)!.resolvedAt).toBeTruthy()
    // Resolved: no anchor left in the manuscript, nothing locked.
    expect(anchors(ed).every((a) => a === null)).toBe(true)
    expect(ed.state.selection.from).toBe(blockPos(ed, 1) + 1)

    run(ed, undo)
    expect(texts(ed)[1]).toBe('The rain came at dusk, soft at first.')
    const back = getRewrite(id)!
    expect(back.status).toBe('open')
    expect(back.choice).toBeUndefined()
    expect(back.versions).toEqual(versions)
    expect(passageRange(ed.state.doc, back.anchor)).toEqual({ from: blockPos(ed, 1), to: blockPos(ed, 2) })

    run(ed, redo)
    expect(texts(ed)[1]).toBe('The rain came at night, hard from the start.')
    expect(getRewrite(id)).toMatchObject({ status: 'resolved', choice: vid })
    expect(anchors(ed).every((a) => a === null)).toBe(true)
  })

  it('is a minimal word-level edit: unchanged words keep their marks (comments, bold); paragraph style follows the version', () => {
    const ed = mount([title('One'), para(text('The rain came '), text('at dusk', [{ type: 'comment', attrs: { id: 'c1' } }]), text(', soft at first.')), para(text('Bold words', [{ type: 'bold' }]), text(' here.'))])
    const [id, vid] = rewrite(ed, 1, 2, [
      para('The rain came at dusk, hard at first.'),
      { type: 'paragraph', attrs: { textAlign: 'center' }, content: [text('Bold words here.')] },
    ])
    act(() => void keepVersionNow(vid, id))
    expect(texts(ed).slice(1)).toEqual(['The rain came at dusk, hard at first.', 'Bold words here.'])
    // The comment stays on its (unchanged) words.
    const commented: string[] = []
    ed.state.doc.descendants((n) => {
      if (n.isText && n.marks.some((m) => m.type.name === 'comment' && m.attrs.id === 'c1')) commented.push(n.text!)
    })
    expect(commented.join('')).toBe('at dusk')
    // Formatting the version removed from unchanged words is removed; the style change applied.
    const p2 = ed.state.doc.child(2)
    expect(p2.attrs.textAlign).toBe('center')
    p2.descendants((n) => void expect(n.marks.some((m) => m.type.name === 'bold')).toBe(false))
  })

  it('a removed commented word hides its comment; undo restores the mark', () => {
    const ed = mount([title('One'), para(text('Keep '), text('this', [{ type: 'comment', attrs: { id: 'c2' } }]), text(' word.'))])
    const [id, vid] = rewrite(ed, 1, 1, [para('Keep that word.')])
    const hasMark = () => {
      let found = false
      ed.state.doc.descendants((n) => void (found ||= n.marks.some((m) => m.type.name === 'comment' && m.attrs.id === 'c2')))
      return found
    }
    act(() => void keepVersionNow(vid, id))
    expect(hasMark()).toBe(false)
    run(ed, undo)
    expect(hasMark()).toBe(true)
  })

  it('carries an edited footnote text and keeps the footnote reference', () => {
    const ed = mount()
    const [id, vid] = rewrite(ed, 2, 2, [para('She shut the window', footnote('A longer note.'), ' and listened.')])
    act(() => void keepVersionNow(vid, id))
    const notes: string[] = []
    ed.state.doc.descendants((n) => void (n.type.name === 'footnote' && notes.push(n.textContent)))
    expect(notes).toEqual(['A longer note.'])
    expect(texts(ed)[2]).toBe('She shut the windowA longer note. and listened.')
  })

  it('adds and removes whole paragraphs and keeps breaks', () => {
    const ed = mount([title('One'), para('Alpha line.'), { type: 'sceneBreak' }, para('Beta line.'), para('Gamma line.')])
    const [id, vid] = rewrite(ed, 1, 4, [para('Alpha line.'), para('A new line between.'), { type: 'sceneBreak' }, para('Gamma line, edited.')])
    act(() => void keepVersionNow(vid, id))
    const types: string[] = []
    ed.state.doc.forEach((n) => types.push(n.type.name))
    expect(types).toEqual(['heading', 'paragraph', 'paragraph', 'sceneBreak', 'paragraph'])
    expect(texts(ed)).toEqual(['One', 'Alpha line.', 'A new line between.', '', 'Gamma line, edited.'])
  })

  it('with Track Changes on: word-level tracked insertions and deletions; accept gives the version, reject the original', () => {
    const ed = mount()
    const [id, vid] = rewrite(ed, 1, 1, [para('The rain came at night, soft at first.')])
    act(() => setTracking(true))
    act(() => void keepVersionNow(vid, id))
    const ins: string[] = []
    const del: string[] = []
    ed.state.doc.child(1).descendants((n) => {
      if (n.marks.some((m) => m.type.name === 'insertion')) ins.push(n.text!)
      if (n.marks.some((m) => m.type.name === 'deletion')) del.push(n.text!)
    })
    // Only the words that differ, not the whole paragraph.
    expect(del.join('|')).toBe('dusk')
    expect(ins.join('|')).toBe('night')
    act(() => setTracking(false))
    const before = ed.state
    act(() => ed.view.dispatch(acceptAll(ed.state)!))
    expect(texts(ed)[1]).toBe('The rain came at night, soft at first.')
    act(() => ed.view.updateState(before))
    act(() => ed.view.dispatch(rejectAll(ed.state)!))
    expect(texts(ed)[1]).toBe('The rain came at dusk, soft at first.')
  })

  it('asks before removing a chapter title, and does nothing when the answer is no', async () => {
    const ed = mount()
    const [id, vid] = rewrite(ed, 0, 1, [para('The rain came at dusk, soft at first.')])
    const asked: string[] = []
    setRewriteConfirm(async (req) => {
      asked.push(req.title)
      return false
    })
    let ok = true
    await act(async () => void (ok = await keepVersion(vid, id)))
    expect(ok).toBe(false)
    expect(asked).toEqual(['Remove a chapter title?'])
    expect(texts(ed)[0]).toBe('One')
    expect(getRewrite(id)!.status).toBe('open')
    setRewriteConfirm(async () => true)
    await act(async () => void (ok = await keepVersion(vid, id)))
    expect(ok).toBe(true)
    expect(texts(ed)[0]).toBe('The rain came at dusk, soft at first.')
  })
})

describe('Keep Original, Discard, Reopen', () => {
  it('Keep Original leaves the text, records the choice and keeps the versions; undo reopens it', () => {
    const ed = mount()
    const [id] = rewrite(ed, 1, 1, [para('Something else.')])
    const before = texts(ed)
    act(() => void keepOriginal(id))
    expect(texts(ed)).toEqual(before)
    expect(getRewrite(id)).toMatchObject({ status: 'resolved', choice: 'original' })
    expect(getRewrite(id)!.versions[0].doc.content![0].content![0].text).toBe('Something else.')
    expect(anchors(ed).every((a) => a === null)).toBe(true)
    run(ed, undo)
    expect(getRewrite(id)!.status).toBe('open')
    expect(anchors(ed)[1]).toBe(getRewrite(id)!.anchor)
  })

  it('Discard removes the re-write; undo brings it back with its versions', () => {
    const ed = mount()
    const [id] = rewrite(ed, 1, 1, [para('Something else.')])
    const record = getRewrite(id)!
    act(() => void discardRewrite(id))
    expect(getRewrite(id)).toBeUndefined()
    expect(anchors(ed).every((a) => a === null)).toBe(true)
    run(ed, undo)
    expect(getRewrite(id)).toEqual(record)
    expect(anchors(ed)[1]).toBe(record.anchor)
    run(ed, redo)
    expect(getRewrite(id)).toBeUndefined()
  })

  it('Reopen finds the kept text, takes it as the original, locks it again; undo resolves it again', () => {
    const ed = mount()
    const [id, vid] = rewrite(ed, 1, 1, [para('The rain came at night.')])
    act(() => void keepVersionNow(vid, id))
    // Edited afterwards: still found (the most similar paragraph).
    act(() => ed.view.dispatch(ed.state.tr.insertText(' Again', blockPos(ed, 1) + 1 + 'The rain came at night'.length)))
    let ok = false
    act(() => void (ok = reopenRewrite(id)))
    expect(ok).toBe(true)
    const r = getRewrite(id)!
    expect(r.status).toBe('open')
    expect(r.choice).toBeUndefined()
    expect(r.original.content![0].content![0].text).toBe('The rain came at night Again.')
    expect(r.versions[0].id).toBe(vid)
    expect(rw().openId).toBe(id)
    expect(anchors(ed)[1]).toBe(r.anchor)
    act(() => closeRewrite())
    run(ed, undo)
    expect(getRewrite(id)).toMatchObject({ status: 'resolved', choice: vid })
    expect(getRewrite(id)!.original.content![0].content![0].text).toBe('The rain came at dusk, soft at first.')
    expect(anchors(ed).every((a) => a === null)).toBe(true)
  })

  it('Reopen says so when the text is gone', () => {
    const ed = mount()
    const [id] = rewrite(ed, 1, 1)
    act(() => void keepOriginal(id))
    act(() => ed.view.dispatch(ed.state.tr.delete(blockPos(ed, 1), blockPos(ed, 2))))
    expect(reopenRewrite(id)).toBe(false)
    expect(rw().notice?.kind).toBe('notFound')
  })

  it('locatePassage: without a hint, two equal matches are ambiguous; never blocks of another open re-write', () => {
    const ed = mount([para('Same.'), para('Same.'), para('Other.')])
    const kept = ed.schema.nodeFromJSON({ type: 'doc', content: [para('Same.')] })
    expect(locatePassage(ed.state.doc, kept)).toEqual({ ambiguous: true })
    const [id] = rewrite(ed, 0, 0)
    const open = new Set([getRewrite(id)!.anchor])
    expect(locatePassage(ed.state.doc, kept, open)).toEqual({ from: blockPos(ed, 1), to: blockPos(ed, 2) })
  })

  it('Reopen does not pick a duplicate short paragraph earlier in the book (the saved location wins)', () => {
    const ed = mount([title('One'), para('He nodded.'), para('The road went on.'), title('Two'), para('Rain.'), para('He nodded.'), para('They left.')])
    const [id] = rewrite(ed, 5, 5)
    act(() => void keepOriginal(id))
    expect(getRewrite(id)!.location).toEqual({ block: 5, chapter: 1, before: 'Rain.', after: 'They left.' })
    // Text typed before both copies moves them; the hint is the neighbours, not the index alone.
    act(() => ed.view.dispatch(ed.state.tr.insert(blockPos(ed, 1), ed.schema.nodeFromJSON(para('A new opening line.')))))
    act(() => void reopenRewrite(id))
    expect(getRewrite(id)!.status).toBe('open')
    expect(anchors(ed)[6]).toBe(getRewrite(id)!.anchor)
    expect(anchors(ed)[2]).toBeNull()
  })

  it('Reopen refuses with a notice when the text fits several places equally', () => {
    const ed = mount([para('A.'), para('He nodded.'), para('B.'), para('A.'), para('He nodded.'), para('B.')])
    const [id] = rewrite(ed, 4, 4)
    act(() => void keepOriginal(id))
    expect(reopenRewrite(id)).toBe(false)
    expect(rw().notice).toMatchObject({ kind: 'notFound', ambiguous: true })
    expect(getRewrite(id)!.status).toBe('resolved')
    expect(anchors(ed).every((a) => a === null)).toBe(true)
  })

  it('Reopen refuses when the only match is far from where the passage was', () => {
    const ed = mount([title('One'), para('Far away.'), para('x1.'), para('x2.'), para('x3.'), para('x4.'), para('x5.'), title('Two'), para('Near.'), para('Kept here.'), para('After.')])
    const [id] = rewrite(ed, 9, 9)
    act(() => void keepOriginal(id))
    // The passage and both its neighbours are rewritten by hand; an equal paragraph exists far away only.
    act(() => ed.view.dispatch(ed.state.tr.delete(blockPos(ed, 8), blockPos(ed, 11))))
    act(() => ed.view.dispatch(ed.state.tr.insertText(' Kept here.', blockPos(ed, 1) + 1 + 'Far away.'.length)))
    act(() => ed.view.dispatch(ed.state.tr.insert(blockPos(ed, 2), ed.schema.nodeFromJSON(para('Kept here.')))))
    expect(reopenRewrite(id)).toBe(false)
    expect(rw().notice).toMatchObject({ kind: 'notFound' })
  })
})

describe('review fixes', () => {
  it('redo after the kept version was edited re-applies what was kept; the record keeps a frozen copy', () => {
    const ed = mount()
    const [id, vid] = rewrite(ed, 1, 1, [para('The rain came at night.')])
    act(() => void keepVersionNow(vid, id))
    const kept = getRewrite(id)!.kept
    expect(kept!.content![0].content![0].text).toBe('The rain came at night.')
    run(ed, undo)
    // The version is edited while the re-write is open again.
    const edited = { type: 'doc', content: [para('Something else entirely.')] } as DocNodeJSON
    act(() => useStore.getState().rewriteActions.changed(rw().rewrites.map((x) => (x.id === id ? { ...x, versions: [{ ...x.versions[0], doc: edited }] } : x))))
    run(ed, redo)
    expect(texts(ed)[1]).toBe('The rain came at night.')
    expect(getRewrite(id)).toMatchObject({ status: 'resolved', choice: vid, kept })
    // rewrites.json keeps the frozen copy (and a choice whose version changed stays meaningful).
    expect(parseRewritesFile({ version: 1, rewrites: [serializeRewrite(getRewrite(id)!)] }).rewrites[0].kept).toEqual(kept)
  })

  it('a list: a one-word edit in one item is word-level, a comment in another item survives (tracked too)', () => {
    const item = (...c: (string | JSONContent)[]): JSONContent => ({ type: 'listItem', content: [para(...c)] })
    const list = (...items: JSONContent[]): JSONContent => ({ type: 'bulletList', content: items })
    const ed = mount([title('One'), list(item(text('First '), text('item', [{ type: 'comment', attrs: { id: 'c9' } }]), text(' here.')), item('Second item here.'))])
    const [id, vid] = rewrite(ed, 1, 1, [list(item('First item here.'), item('Second point here.'))])
    act(() => setTracking(true))
    act(() => void keepVersionNow(vid, id))
    expect(ed.state.doc.child(1).type.name).toBe('bulletList')
    let comment = ''
    ed.state.doc.descendants((n) => void (n.isText && n.marks.some((m) => m.type.name === 'comment') && (comment += n.text)))
    expect(comment).toBe('item')
    const ins: string[] = []
    const del: string[] = []
    ed.state.doc.descendants((n) => {
      if (n.isText && n.marks.some((m) => m.type.name === 'insertion')) ins.push(n.text!)
      if (n.isText && n.marks.some((m) => m.type.name === 'deletion')) del.push(n.text!)
    })
    expect(del).toEqual(['item'])
    expect(ins).toEqual(['point'])
  })

  it('asks when a version demotes one chapter title and promotes another (same count)', async () => {
    const ed = mount()
    const [id, vid] = rewrite(ed, 0, 1, [para('One'), title('The rain came at dusk, soft at first.')])
    const asked: string[] = []
    setRewriteConfirm(async (req) => {
      asked.push(req.title)
      return false
    })
    await act(async () => void (await keepVersion(vid, id)))
    expect(asked).toEqual(['Change the chapters?'])
    // A renamed title is not a removal: no question.
    const [id2, vid2] = rewrite(ed, 4, 4, [title('Two, renamed')])
    asked.length = 0
    await act(async () => void (await keepVersion(vid2, id2)))
    expect(asked).toEqual([])
    expect(texts(ed)[4]).toBe('Two, renamed')
  })

  it('Discard says so; undo puts the re-write back at its place in the list', () => {
    const ed = mount()
    const [a] = rewrite(ed, 1, 1)
    const [b] = rewrite(ed, 3, 3)
    act(() => void discardRewrite(a))
    expect(rw().notice?.kind).toBe('discarded')
    expect(rw().rewrites.map((r) => r.id)).toEqual([b])
    run(ed, undo)
    expect(rw().rewrites.map((r) => r.id)).toEqual([a, b])
  })
})

describe('stale anchors', () => {
  it('an undo that puts back blocks anchored to a re-write that is not open strips the anchor', () => {
    const ed = mount()
    const [id] = rewrite(ed, 3, 3)
    const anchor = getRewrite(id)!.anchor
    // Removed by a programmatic edit (in history), then the re-write was resolved elsewhere.
    act(() => ed.view.dispatch(ed.state.tr.delete(blockPos(ed, 3), blockPos(ed, 4)).setMeta(BULK_EDIT_META, true)))
    act(() => useStore.getState().rewriteActions.changed(rw().rewrites.map((r) => (r.id === id ? ({ ...r, status: 'resolved' } as RewriteRecord) : r))))
    run(ed, undo)
    expect(texts(ed)[3]).toBe('Nobody spoke.')
    expect(anchors(ed)).not.toContain(anchor)
  })
})

describe('rewrites.json', () => {
  it('keeps the choice, its time, the kept copy and the location; a dangling choice is dropped; open re-writes have none', () => {
    const ed = mount()
    const [id, vid] = rewrite(ed, 1, 1, [para('X.')])
    act(() => void keepVersionNow(vid, id))
    const raw = serializeRewrite(getRewrite(id)!)
    expect(raw).toMatchObject({ status: 'resolved', choice: vid })
    expect(parseRewritesFile({ version: 1, rewrites: [raw] }).rewrites[0]).toEqual(getRewrite(id))
    // A choice of a version that is gone: kept when the frozen copy is there, dropped otherwise.
    expect(parseRewritesFile({ version: 1, rewrites: [{ ...raw, choice: 'v-gone' }] }).rewrites[0].choice).toBe('v-gone')
    expect(parseRewritesFile({ version: 1, rewrites: [{ ...raw, choice: 'v-gone', kept: undefined }] }).rewrites[0].choice).toBeUndefined()
    expect(raw.location).toEqual({ block: 1, chapter: 0, before: 'One', after: 'She closed the window and listened.' })
    expect(parseRewritesFile({ version: 1, rewrites: [{ ...raw, status: 'open' }] }).rewrites[0].choice).toBeUndefined()
  })

  it('the step serializes (history JSON)', () => {
    const s = new RewriteStateStep('rw-1', 'rw-1', { status: 'open', choice: null }, { status: 'resolved', choice: 'original' })
    const back = RewriteStateStep.fromJSON(null as never, s.toJSON() as never)
    expect(back.invert().after).toEqual({ status: 'open', choice: null })
    expect(back.opens).toBe(false)
  })
})
