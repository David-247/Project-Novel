import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Editor } from '@tiptap/core'
import { getEditor, NovelEditor, setDocJSON, type JSONContent } from '@/features/editor'
import { setTracking } from '@/features/track-changes'
import { useStore } from '@/shared/store'
import { lockedInRange } from './anchor'
import { closeRewrite, openRewriteWithVersion, wireRewriteAnchors } from './commands'
import { __resetRewritesFileForTests } from './persistence'

/** The tutor's proposals (Phase 5 Task 9): a re-write opened on a passage with a ready-made version. */

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
const h1 = (t: string): JSONContent => ({ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: t }] })
const DOC: JSONContent[] = [h1('One'), para('Alpha line.'), para('Beta lnie.'), para('Gamma line.'), h1('Two'), para('Delta line.')]

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
const rw = () => useStore.getState().rewrite
const textOf = (doc: JSONContent | undefined) => (doc?.content ?? []).map((b) => (b.content ?? []).map((c) => c.text ?? '').join(''))

beforeEach(() => {
  useStore.getState().rewriteActions.loaded([])
  __resetRewritesFileForTests()
  act(() => setTracking(false))
})
afterEach(() => {
  act(() => closeRewrite())
  cleanup()
})

describe('openRewriteWithVersion', () => {
  it('opens a re-write on the whole paragraphs of the range with a "Tutor suggestion" version, the manuscript unchanged', () => {
    const ed = mount()
    const before = ed.state.doc
    const from = blockPos(ed, 2) + 3
    let result: ReturnType<typeof openRewriteWithVersion> = { ok: false, reason: 'refused' }
    act(() => {
      result = openRewriteWithVersion({ from, to: from + 2 }, (tr) => {
        // "lnie" -> "line" in block 2.
        const at = blockPos(ed, 2) + 1 + 'Beta '.length
        tr.insertText('line', at, at + 4)
        return true
      })
    })
    expect(result.ok).toBe(true)
    const r = rw()
    expect(r.openId).not.toBeNull()
    const record = r.rewrites.find((x) => x.id === r.openId)!
    expect(textOf(record.original)).toEqual(['Beta lnie.'])
    const version = record.versions.find((v) => v.id === r.activeVersionId)!
    expect(version.name).toBe('Tutor suggestion')
    expect(textOf(version.doc)).toEqual(['Beta line.'])
    expect(record.currentVersionId).toBe(version.id)
    // The manuscript text is untouched (only the passage anchor was set).
    expect(ed.state.doc.textContent).toBe(before.textContent)
  })

  it('covers every paragraph from the first to the last of the range', () => {
    const ed = mount()
    let result: ReturnType<typeof openRewriteWithVersion> = { ok: false, reason: 'refused' }
    act(() => {
      result = openRewriteWithVersion({ from: blockPos(ed, 1) + 1, to: blockPos(ed, 3) + 2 }, () => true)
    })
    expect(result.ok).toBe(true)
    const record = rw().rewrites.find((x) => x.id === rw().openId)!
    expect(textOf(record.original)).toEqual(['Alpha line.', 'Beta lnie.', 'Gamma line.'])
  })

  it('refuses a range across a chapter start ("span"), with nothing changed', () => {
    const ed = mount()
    const doc = ed.state.doc
    let result: ReturnType<typeof openRewriteWithVersion> = { ok: true, rewriteId: '', versionId: '' }
    act(() => {
      result = openRewriteWithVersion({ from: blockPos(ed, 3) + 1, to: blockPos(ed, 5) + 2 }, () => true)
    })
    expect(result).toEqual({ ok: false, reason: 'span' })
    expect(rw().openId).toBeNull()
    expect(rw().rewrites).toEqual([])
    expect(ed.state.doc.eq(doc)).toBe(true)
  })

  it('refuses a passage already in an open re-write ("locked") and while the view is open ("open")', () => {
    const ed = mount()
    act(() => void openRewriteWithVersion({ from: blockPos(ed, 2) + 1, to: blockPos(ed, 2) + 2 }, () => true))
    expect(rw().openId).not.toBeNull()
    let r1: ReturnType<typeof openRewriteWithVersion> = { ok: true, rewriteId: '', versionId: '' }
    act(() => {
      r1 = openRewriteWithVersion({ from: blockPos(ed, 3) + 1, to: blockPos(ed, 3) + 2 }, () => true)
    })
    expect(r1).toEqual({ ok: false, reason: 'open' })
    act(() => closeRewrite())
    let r2: ReturnType<typeof openRewriteWithVersion> = { ok: true, rewriteId: '', versionId: '' }
    act(() => {
      r2 = openRewriteWithVersion({ from: blockPos(ed, 2) + 1, to: blockPos(ed, 2) + 2 }, () => true)
    })
    expect(r2).toEqual({ ok: false, reason: 'locked' })
    expect(rw().rewrites).toHaveLength(1)
  })

  it('refuses when the reviser fails ("refused"), leaving no re-write behind', () => {
    const ed = mount()
    const doc = ed.state.doc
    let result: ReturnType<typeof openRewriteWithVersion> = { ok: true, rewriteId: '', versionId: '' }
    act(() => {
      result = openRewriteWithVersion({ from: blockPos(ed, 2) + 1, to: blockPos(ed, 2) + 2 }, () => false)
    })
    expect(result).toEqual({ ok: false, reason: 'refused' })
    expect(rw().rewrites).toEqual([])
    expect(ed.state.doc.eq(doc)).toBe(true)
  })
})

describe('lockedInRange', () => {
  it('finds the open passage a range overlaps, and nothing outside it', () => {
    const ed = mount()
    act(() => void openRewriteWithVersion({ from: blockPos(ed, 2) + 1, to: blockPos(ed, 2) + 2 }, () => true))
    act(() => closeRewrite())
    expect(lockedInRange(ed.state, blockPos(ed, 2) + 2, blockPos(ed, 2) + 4)).not.toBeNull()
    expect(lockedInRange(ed.state, blockPos(ed, 3) + 2, blockPos(ed, 3) + 4)).toBeNull()
  })
})
