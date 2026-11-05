import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Editor } from '@tiptap/core'
import { undo } from '@tiptap/pm/history'
import { TextSelection } from '@tiptap/pm/state'
import { getDocJSON, getEditor, NovelEditor, setDocJSON, type JSONContent } from '@/features/editor'
import { listChanges, setTracking } from '@/features/track-changes'
import { BULK_EDIT_META, REWRITE_BLOCK_ATTR } from '@/shared/rewrite'
import { useStore } from '@/shared/store'
import { contrastRatio } from '@/shared/theme'
import { lockedAtSelection, passageRange } from './anchor'
import { closeRewrite, newVersion, wireRewriteAnchors, renameVersion, rewritePassage, selectVersion, stepRewrite } from './commands'
import { parseRewritesFile, REWRITES_VERSION, serializeRewritesFile } from './model'
import { __resetRewritesFileForTests, rewritesSideFile } from './persistence'

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
const para = (t: string): JSONContent => ({ type: 'paragraph', content: [text(t)] })
const chapter = (t: string): JSONContent => ({ type: 'heading', attrs: { level: 1 }, content: [text(t)] })
const DOC: JSONContent[] = [chapter('One'), para('Alpha line.'), para('Beta line.'), para('Gamma line.'), chapter('Two'), para('Delta line.')]

function mount(content: JSONContent[] = DOC): Editor {
  render(<NovelEditor />)
  act(() => setDocJSON({ type: 'doc', content }))
  return getEditor()!
}

/** Start position of top-level block `i`. */
function blockPos(ed: Editor, i: number): number {
  let pos = 0
  for (let k = 0; k < i; k++) pos += ed.state.doc.child(k).nodeSize
  return pos
}
const select = (ed: Editor, from: number, to = from) => ed.view.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, from, to)))
const rw = () => useStore.getState().rewrite
const anchors = (ed: Editor) => {
  const out: (string | null)[] = []
  ed.state.doc.forEach((n) => out.push(n.attrs[REWRITE_BLOCK_ATTR] as string | null))
  return out
}

/** Select from inside block `a` to inside block `b` and run Re-write Passage…. */
function rewrite(ed: Editor, a: number, b: number): string {
  select(ed, blockPos(ed, a) + 2, blockPos(ed, b) + 2)
  act(() => void rewritePassage())
  return rw().openId!
}

beforeEach(() => {
  useStore.getState().rewriteActions.loaded([])
  __resetRewritesFileForTests()
  act(() => setTracking(false))
})
afterEach(() => cleanup())

describe('Re-write Passage…', () => {
  it('anchors whole paragraphs of the selection and snapshots them', () => {
    const ed = mount()
    const id = rewrite(ed, 1, 2)
    expect(anchors(ed)).toEqual([null, id, id, null, null, null])
    const r = rw().rewrites[0]
    expect(r).toMatchObject({ id, anchor: id, status: 'open' })
    expect(r.original).toEqual({ type: 'doc', content: [para('Alpha line.'), para('Beta line.')] })
    expect(r.versions).toHaveLength(1)
    expect(r.versions[0]).toMatchObject({ name: 'Version 1', doc: r.original })
    expect(rw().openId).toBe(id)
  })

  it('takes the paragraph at the caret', () => {
    const ed = mount()
    select(ed, blockPos(ed, 3) + 3)
    act(() => void rewritePassage())
    expect(anchors(ed)[3]).toBe(rw().openId)
    expect(anchors(ed).filter(Boolean)).toHaveLength(1)
  })

  it('keeps the anchor out of manuscript.json while null, and in it on the passage', () => {
    const ed = mount()
    const id = rewrite(ed, 2, 2)
    const json = getDocJSON().content!
    expect(json[1].attrs?.[REWRITE_BLOCK_ATTR]).toBeUndefined()
    expect(json[2].attrs?.[REWRITE_BLOCK_ATTR]).toBe(id)
  })

  it('refuses a selection over two chapters', () => {
    const ed = mount()
    select(ed, blockPos(ed, 3) + 2, blockPos(ed, 5) + 2)
    act(() => void rewritePassage())
    expect(rw().rewrites).toHaveLength(0)
    expect(rw().notice?.kind).toBe('span')
    expect(anchors(ed).every((a) => a === null)).toBe(true)
  })

  it('reopens the existing re-write when the selection is in one', () => {
    const ed = mount()
    const id = rewrite(ed, 1, 2)
    act(() => closeRewrite())
    select(ed, blockPos(ed, 2) + 2)
    act(() => void rewritePassage())
    expect(rw().rewrites).toHaveLength(1)
    expect(rw().openId).toBe(id)
  })

  it('is not an undo step and not a tracked change', () => {
    const ed = mount()
    act(() => setTracking(true))
    const id = rewrite(ed, 1, 1)
    expect(listChanges(ed.state.doc)).toEqual([])
    act(() => void undo(ed.state, ed.view.dispatch))
    expect(anchors(ed)[1]).toBe(id)
    act(() => setTracking(false))
  })
})

describe('the locked passage', () => {
  it('refuses typing inside it and offers the re-write; text outside stays editable', () => {
    const ed = mount()
    const id = rewrite(ed, 1, 2)
    act(() => closeRewrite())
    const before = ed.state.doc
    select(ed, blockPos(ed, 2) + 3)
    expect(lockedAtSelection(ed.state)?.id).toBe(id)
    expect(rw().caretIn).toBe(id)
    act(() => ed.view.dispatch(ed.state.tr.insertText('X')))
    expect(ed.state.doc.eq(before)).toBe(true)
    expect(rw().notice).toMatchObject({ kind: 'locked', id })
    // Joining the next paragraph into the passage (Backspace at its start) is refused too.
    act(() => ed.view.dispatch(ed.state.tr.delete(blockPos(ed, 3) - 1, blockPos(ed, 3) + 1)))
    expect(ed.state.doc.eq(before)).toBe(true)
    // Outside: fine, also right after the passage.
    select(ed, blockPos(ed, 3) + 1)
    act(() => ed.view.dispatch(ed.state.tr.insertText('Y')))
    expect(ed.state.doc.child(3).textContent).toBe('YGamma line.')
    expect(rw().caretIn).toBeNull()
  })

  it('lets Replace All through and marks the re-write "original changed"', async () => {
    const ed = mount()
    rewrite(ed, 1, 1)
    act(() => closeRewrite())
    const at = blockPos(ed, 1) + 1
    await act(async () => {
      ed.view.dispatch(ed.state.tr.insertText('Omega', at, at + 5).setMeta(BULK_EDIT_META, true))
      await Promise.resolve()
    })
    expect(ed.state.doc.child(1).textContent).toBe('Omega line.')
    expect(rw().rewrites[0].originalChanged).toBe(true)
    // The anchor survives the replacement.
    expect(passageRange(ed.state.doc, rw().rewrites[0].anchor)).not.toBeNull()
  })

  it('unlocks once the re-write is no longer open (resolved)', () => {
    const ed = mount()
    rewrite(ed, 1, 1)
    act(() => closeRewrite())
    act(() => useStore.getState().rewriteActions.changed(rw().rewrites.map((r) => ({ ...r, status: 'resolved' as const }))))
    select(ed, blockPos(ed, 1) + 2)
    act(() => ed.view.dispatch(ed.state.tr.insertText('Z')))
    expect(ed.state.doc.child(1).textContent).toBe('AZlpha line.')
  })
})

describe('versions', () => {
  it('creates, renames and switches versions; Next / Previous Re-write cycle through re-writes', () => {
    const ed = mount()
    const first = rewrite(ed, 1, 1)
    const v2 = newVersion()!
    expect(rw().rewrites[0].versions.map((v) => v.name)).toEqual(['Version 1', 'Version 2'])
    expect(rw().activeVersionId).toBe(v2)
    renameVersion(v2, '  Darker   take ')
    expect(rw().rewrites[0].versions[1].name).toBe('Darker take')
    renameVersion(v2, '   ')
    expect(rw().rewrites[0].versions[1].name).toBe('Darker take')
    selectVersion(rw().rewrites[0].versions[0].id)
    expect(rw().rewrites[0].currentVersionId).toBe(rw().rewrites[0].versions[0].id)
    act(() => closeRewrite())
    const second = rewrite(ed, 5, 5)
    act(() => void stepRewrite(1))
    expect(rw().openId).toBe(first)
    act(() => void stepRewrite(1))
    expect(rw().openId).toBe(second)
  })
})

describe('rewrites.json', () => {
  it('round-trips re-writes and keeps unknown keys and unreadable entries', () => {
    const version = { id: 'v-1', name: 'Version 1', doc: { type: 'doc', content: [para('A')] }, updatedAt: '2026-11-05T10:00:00.000Z', mood: 'grim' }
    const good = {
      id: 'rw-1',
      createdAt: '2026-11-05T09:00:00.000Z',
      anchor: 'rw-1',
      original: { type: 'doc', content: [para('A')] },
      versions: [version],
      currentVersionId: 'v-1',
      status: 'open',
      pinned: true,
    }
    const bad = { id: 'rw-2', versions: [] }
    const file = { version: 1, rewrites: [good, bad], owner: 'me' }
    const parsed = parseRewritesFile(file)
    expect(parsed.rewrites).toHaveLength(1)
    expect(parsed.unreadable).toEqual([bad])
    expect(parsed.rewrites[0].extra).toEqual({ pinned: true })
    expect(serializeRewritesFile(parsed)).toEqual(file)
    expect(parseRewritesFile({ version: REWRITES_VERSION + 1, rewrites: [] }).newer).toBe(REWRITES_VERSION + 1)
    expect(() => parseRewritesFile({ rewrites: 'nope' })).toThrow()
  })

  it('a missing file is empty; the side file serializes what the store holds and loads it back', () => {
    const ed = mount()
    expect(rewritesSideFile.load(null)).toBeUndefined()
    expect(rewritesSideFile.serialize().empty).toBe(true)
    rewrite(ed, 1, 2)
    newVersion()
    const v0 = rewritesSideFile.getVersion()
    const { data, empty } = rewritesSideFile.serialize()
    expect(empty).toBe(false)
    const saved = structuredClone(data)
    rewritesSideFile.load(null)
    expect(rw().rewrites).toHaveLength(0)
    rewritesSideFile.load(saved)
    expect(rw().rewrites[0].versions).toHaveLength(2)
    expect(rw().openId).toBeNull()
    expect(rewritesSideFile.getVersion()).toBe(v0)
    expect(rewritesSideFile.serialize().data).toEqual(saved)
  })
})

describe('colours', () => {
  const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '')
  const block = (source: string, selector: string) => {
    const s = strip(source)
    const at = s.indexOf(selector)
    if (at < 0) throw new Error(`not found: ${selector}`)
    const body = s.slice(at, s.indexOf('}', at))
    return Object.fromEntries([...body.matchAll(/--([a-z0-9-]+)\s*:\s*(#[0-9a-f]{6})\s*;/gi)].map((m) => [m[1], m[2]]))
  }
  const surfaces = read('src/shared/theme/surfaces.css')
  const css = read('src/features/rewrite/rewrite.css')
  const papers = {
    white: ":is(:root, .nv-surface-preview)[data-surface='white'] {",
    dark: ":is(:root, .nv-surface-preview)[data-surface='dark'] {",
    'book-light': ":is(:root, .nv-surface-preview)[data-surface='book'] {",
    'book-dark': ":is(:root, .nv-surface-preview)[data-surface='book'][data-theme='dark'] {",
  }
  for (const [name, sel] of Object.entries(papers)) {
    it(`page text keeps 4.5:1 on the tints and the marks reach 3:1 on the ${name} paper`, () => {
      const paper = block(surfaces, sel)
      const rw = block(css, sel)
      const fg = paper['page-fg']
      const bg = paper['page-bg']
      for (const tint of ['page-rw-del-bg', 'page-rw-ins-bg', 'page-rw-lock-bg']) expect(contrastRatio(fg, rw[tint]), `${tint} on ${name}`).toBeGreaterThanOrEqual(4.5)
      for (const mark of ['page-rw-del-line', 'page-rw-ins-line', 'page-rw-ink']) expect(contrastRatio(rw[mark], bg), `${mark} on ${name}`).toBeGreaterThanOrEqual(3)
      expect(contrastRatio(rw['page-rw-del-line'], rw['page-rw-del-bg']), `strike on its tint (${name})`).toBeGreaterThanOrEqual(3)
      expect(contrastRatio(rw['page-rw-ins-line'], rw['page-rw-ins-bg']), `underline on its tint (${name})`).toBeGreaterThanOrEqual(3)
      expect(contrastRatio(rw['page-rw-ink'], rw['page-rw-lock-bg']), `side bar on the passage tint (${name})`).toBeGreaterThanOrEqual(3)
      // Stitches sit on the desk.
      expect(contrastRatio(rw['page-rw-ink'], paper['desk-bg']), `stitch on the ${name} desk`).toBeGreaterThanOrEqual(3)
    })
  }
})
