import { Editor, type JSONContent } from '@tiptap/core'
import { Fragment, Slice, type Node as PMNode } from '@tiptap/pm/model'
import { NodeSelection, TextSelection } from '@tiptap/pm/state'
import { undo } from '@tiptap/pm/history'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { STYLE_IDS } from '@/shared/book'
import { useStore } from '@/shared/store'
import { createEditorExtensions, blockPlainText, collectFootnotes } from '@/features/editor'
import { resolveFootnoteOptions } from '@/shared/book'
import { acceptAll, rejectAll, acceptChange, listChanges } from './review'
import { resetTrackingSession, TRACK_SKIP_META } from './record'
import { TrackChanges, TRACK_FAILED_NOTICE } from './extension'
import { setTracking } from './commands'

/**
 * Transaction rewrite rules (docs/track-changes.md, "Recording"). A headless editor with the real
 * extension list; Track Changes on through the book setting, as in the app.
 */

const editors: Editor[] = []
let author = 'Ann'
/** An author whose name cannot be read: makes the rewrite throw. */
let brokenAuthor = false
const broken = {
  get name(): string {
    throw new Error('boom')
  },
}

function make(content: JSONContent[]): Editor {
  const extensions = createEditorExtensions().map((e) =>
    e.name === 'trackChanges' ? TrackChanges.configure({ getAuthor: () => (brokenAuthor ? broken : { name: author }) }) : e,
  )
  const ed = new Editor({ element: document.createElement('div'), extensions, content: { type: 'doc', content } })
  editors.push(ed)
  return ed
}

beforeAll(() => {
  const emptyRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList
  Range.prototype.getClientRects ??= emptyRects
  Range.prototype.getBoundingClientRect ??= () => ({ top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
  Element.prototype.getClientRects ??= emptyRects
  document.elementFromPoint ??= () => null
})
beforeEach(() => {
  author = 'Ann'
  resetTrackingSession()
  useStore.getState().bookActions.setTrackChanges(true)
  useStore.getState().trackChangesActions.setMarkupView('all')
})
afterEach(() => {
  editors.splice(0).forEach((e) => e.destroy())
  useStore.getState().bookActions.resetBook()
})

const t = (text: string, marks?: JSONContent['marks']): JSONContent => ({ type: 'text', text, ...(marks ? { marks } : {}) })
const p = (...content: JSONContent[]): JSONContent => ({ type: 'paragraph', ...(content.length ? { content } : {}) })

/** Compact picture of the document: {+ins} {-del} {~format}, +¶ / -¶ before inserted / deleted blocks. */
function show(doc: PMNode): string {
  const out: string[] = []
  doc.descendants((node) => {
    if (node.isBlock && (node.isTextblock || node.isLeaf)) {
      let s = node.attrs.trackedInsert ? '+¶' : node.attrs.trackedDelete ? '-¶' : ''
      if (node.attrs.trackedStyleChange) s += '~¶'
      if (node.isLeaf) s += `[${node.type.name}]`
      node.forEach((c) => (s += inline(c)))
      out.push(s)
      return false
    }
    return true
  })
  return out.join(' | ')
}
function inline(n: PMNode): string {
  let s = n.isText ? n.text! : n.type.name === 'footnote' ? `^(${n.content.size ? n.textContent : ''})` : `[${n.type.name}]`
  if (n.type.name === 'footnote' && n.content.size) {
    s = '^('
    n.forEach((c) => (s += inline(c)))
    s += ')'
  }
  const names = n.marks.map((m) => m.type.name)
  if (names.includes('formatChange')) s = `{~${s}}`
  if (names.includes('insertion')) s = `{+${s}}`
  if (names.includes('deletion')) s = `{-${s}}`
  return s
}

const at = (ed: Editor, pos: number) => ed.view.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, pos)))
const type = (ed: Editor, text: string) => {
  for (const ch of text) ed.view.dispatch(ed.state.tr.insertText(ch))
}
/**
 * A key press: the editor's key handlers first; when none takes Backspace / Delete, what the browser
 * does natively (ProseMirror reads it back as a one-character delete).
 */
function key(ed: Editor, name: string) {
  const before = ed.state.doc
  const ev = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })
  ed.view.dom.dispatchEvent(ev)
  if (ed.state.doc !== before || ev.defaultPrevented) return
  const { head, empty } = ed.state.selection
  if (!empty) return void ed.view.dispatch(ed.state.tr.deleteSelection())
  if (name === 'Backspace') ed.view.dispatch(ed.state.tr.delete(head - 1, head))
  if (name === 'Delete') ed.view.dispatch(ed.state.tr.delete(head, head + 1))
}
const ids = (ed: Editor) => listChanges(ed.state.doc).map((c) => c.id)
const apply = (ed: Editor, tr: ReturnType<typeof acceptAll>) => tr && ed.view.dispatch(tr)

describe('typing', () => {
  it('marks typed text as an insertion with author and date; consecutive typing is one change', () => {
    const ed = make([p(t('Hello'))])
    at(ed, 6)
    type(ed, ' world')
    expect(show(ed.state.doc)).toBe('Hello{+ world}')
    const [c] = listChanges(ed.state.doc)
    expect(listChanges(ed.state.doc)).toHaveLength(1)
    expect(c).toMatchObject({ author: 'Ann', kinds: ['insertion'] })
    expect(new Date(c.date).toString()).not.toBe('Invalid Date')
    expect(ed.state.selection.head).toBe(12)
  })

  it("does not extend another author's change, or an earlier session's", () => {
    const ed = make([p(t('ab'))])
    at(ed, 3)
    type(ed, 'c')
    author = 'Ben'
    type(ed, 'd')
    expect(show(ed.state.doc)).toBe('ab{+c}{+d}')
    expect(ids(ed)).toHaveLength(2)
    author = 'Ann'
    resetTrackingSession() // a reopened manuscript: an old change of the same author
    at(ed, 3)
    type(ed, 'x')
    expect(ids(ed)).toHaveLength(3)
  })

  it('turned off: records nothing and keeps the existing marks', () => {
    const ed = make([p(t('ab'))])
    at(ed, 3)
    type(ed, 'c')
    useStore.getState().bookActions.setTrackChanges(false)
    type(ed, 'd')
    expect(show(ed.state.doc)).toBe('ab{+c}d')
  })
})

describe('deleting', () => {
  it('Backspace over untracked text marks it deleted and leaves the caret before it', () => {
    const ed = make([p(t('abc'))])
    at(ed, 4)
    key(ed, 'Backspace')
    key(ed, 'Backspace')
    expect(show(ed.state.doc)).toBe('a{-bc}')
    expect(ids(ed)).toHaveLength(1)
    expect(ed.state.selection.head).toBe(2)
  })

  it('Delete marks the text after the caret and moves past it', () => {
    const ed = make([p(t('abc'))])
    at(ed, 1)
    key(ed, 'Delete')
    expect(show(ed.state.doc)).toBe('{-a}bc')
    expect(ed.state.selection.head).toBe(2)
  })

  it('deleting your own insertion really removes it', () => {
    const ed = make([p(t('ab'))])
    at(ed, 3)
    type(ed, 'xyz')
    key(ed, 'Backspace')
    expect(show(ed.state.doc)).toBe('ab{+xy}')
    ed.view.dispatch(ed.state.tr.delete(1, 5))
    expect(show(ed.state.doc)).toBe('{-ab}')
  })

  it("deleting another author's insertion marks it deleted", () => {
    const ed = make([p(t('ab'))])
    at(ed, 3)
    type(ed, 'x')
    author = 'Ben'
    key(ed, 'Backspace')
    expect(show(ed.state.doc)).toBe('ab{-{+x}}')
  })

  it('Backspace after deleted text goes past it and deletes the character before', () => {
    const ed = make([p(t('abcd'))])
    ed.view.dispatch(ed.state.tr.delete(3, 5)) // "cd" deleted
    at(ed, 5) // after the deleted run
    key(ed, 'Backspace')
    expect(show(ed.state.doc)).toBe('a{-bcd}')
    at(ed, 1)
    key(ed, 'Delete') // Delete before a deleted run: skips nothing, deletes "a"
    expect(show(ed.state.doc)).toBe('{-abcd}')
  })

  it('a range deletion over a mix keeps others, removes own insertions', () => {
    const ed = make([p(t('one two'))])
    at(ed, 4)
    type(ed, 'X')
    ed.view.dispatch(ed.state.tr.delete(2, 7))
    expect(show(ed.state.doc)).toBe('o{-ne t}wo')
  })
})

describe('paste and replace', () => {
  it('paste of several paragraphs: inserted text and an inserted paragraph boundary', () => {
    const ed = make([p(t('ab'))])
    at(ed, 2)
    const schema = ed.schema
    const slice = new Slice(Fragment.from([schema.nodes.paragraph.create(null, schema.text('X')), schema.nodes.paragraph.create(null, schema.text('Y'))]), 1, 1)
    ed.view.dispatch(ed.state.tr.replaceSelection(slice))
    expect(show(ed.state.doc)).toBe('a{+X} | +¶{+Y}b')
    apply(ed, rejectAll(ed.state))
    expect(show(ed.state.doc)).toBe('ab')
  })

  it('pasted text over a selection: deletion first, insertion after it', () => {
    const ed = make([p(t('a cat sat'))])
    ed.view.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, 3, 6)).replaceSelectionWith(ed.schema.text('dog')))
    expect(show(ed.state.doc)).toBe('a {-cat}{+dog} sat')
    expect(ed.state.selection.head).toBe(9)
  })

  it('Replace All (many steps, last match first) records each replacement, one undo step', () => {
    const ed = make([p(t('cat and cat')), p(t('a cat'))])
    const tr = ed.state.tr
    const ranges = [
      [1, 4],
      [9, 12],
      [16, 19],
    ]
    for (let i = ranges.length - 1; i >= 0; i--) tr.replaceWith(ranges[i][0], ranges[i][1], ed.schema.text('dog'))
    ed.view.dispatch(tr)
    expect(show(ed.state.doc)).toBe('{-cat}{+dog} and {-cat}{+dog} | a {-cat}{+dog}')
    undo(ed.state, ed.view.dispatch)
    expect(show(ed.state.doc)).toBe('cat and cat | a cat')
  })

  it('pasted content loses foreign tracking marks', () => {
    const ed = make([p(t('ab'))])
    at(ed, 2)
    const foreign = ed.schema.text('Z', [ed.schema.marks.deletion.create({ id: 'x', author: 'Zed' })])
    ed.view.dispatch(ed.state.tr.replaceSelectionWith(foreign, false))
    expect(show(ed.state.doc)).toBe('a{+Z}b')
    expect(listChanges(ed.state.doc)[0].author).toBe('Ann')
  })
})

describe('IME composition', () => {
  it('composition updates replace their own insertion: one change holding the final text', () => {
    const ed = make([p(t('ab'))])
    at(ed, 3)
    // A composition: "k" then "か" replacing it, then "かな" (each update replaces the composed text).
    ed.view.dispatch(ed.state.tr.insertText('k').setMeta('composition', 1))
    ed.view.dispatch(ed.state.tr.insertText('か', 3, 4).setMeta('composition', 1))
    ed.view.dispatch(ed.state.tr.insertText('かな', 3, 4).setMeta('composition', 1))
    expect(show(ed.state.doc)).toBe('ab{+かな}')
    expect(ids(ed)).toHaveLength(1)
    expect(ed.state.selection.head).toBe(5)
  })

  /** Make the view report an IME composition in progress (as ProseMirror does between compositionstart / end). */
  function composingFlag(ed: Editor) {
    let on = false
    Object.defineProperty(ed.view, 'composing', { configurable: true, get: () => on })
    return (v: boolean) => (on = v)
  }

  it('while composing the text stays unmarked (no re-wrap); the final update marks it, one undo step', () => {
    const ed = make([p(t('ab'))])
    at(ed, 3)
    const composing = composingFlag(ed)
    composing(true)
    ed.view.dispatch(ed.state.tr.insertText('k').setMeta('composition', 1))
    ed.view.dispatch(ed.state.tr.insertText('か', 3, 4).setMeta('composition', 1))
    expect(show(ed.state.doc)).toBe('abか')
    expect(ed.view.dom.querySelector('.nv-ins')).toBeNull()
    // The composition ends with ProseMirror reading the last DOM change.
    composing(false)
    ed.view.dispatch(ed.state.tr.insertText('かな', 3, 4).setMeta('composition', 1))
    expect(show(ed.state.doc)).toBe('ab{+かな}')
    expect(ids(ed)).toHaveLength(1)
    undo(ed.state, ed.view.dispatch)
    expect(show(ed.state.doc)).toBe('ab')
  })

  it('a composition that ends without a last change is marked on compositionend', async () => {
    const ed = make([p(t('ab'))])
    at(ed, 3)
    const composing = composingFlag(ed)
    composing(true)
    ed.view.dispatch(ed.state.tr.insertText('漢字').setMeta('composition', 2))
    expect(show(ed.state.doc)).toBe('ab漢字')
    composing(false)
    ed.view.dom.dispatchEvent(new CompositionEvent('compositionend', { data: '漢字', bubbles: true }))
    await new Promise((r) => setTimeout(r, 60))
    expect(show(ed.state.doc)).toBe('ab{+漢字}')
    undo(ed.state, ed.view.dispatch)
    expect(show(ed.state.doc)).toBe('ab')
  })

  it('an unrelated transaction before compositionend gets no mark; the flush keeps one undo step', async () => {
    const ed = make([p(t('ab'))])
    at(ed, 3)
    const composing = composingFlag(ed)
    composing(true)
    ed.view.dispatch(ed.state.tr.insertText('漢字').setMeta('composition', 4))
    composing(false)
    // A click lands first (no composition meta): it must not carry the composition's mark.
    at(ed, 1)
    expect(show(ed.state.doc)).toBe('ab漢字')
    ed.view.dom.dispatchEvent(new CompositionEvent('compositionend', { data: '漢字', bubbles: true }))
    await new Promise((r) => setTimeout(r, 60))
    expect(show(ed.state.doc)).toBe('ab{+漢字}')
    undo(ed.state, ed.view.dispatch)
    expect(show(ed.state.doc)).toBe('ab')
    // The next composition is a fresh one (the id was cleared).
    at(ed, 3)
    composing(true)
    ed.view.dispatch(ed.state.tr.insertText('か').setMeta('composition', 5))
    composing(false)
    ed.view.dispatch(ed.state.tr.insertText('かな', 3, 4).setMeta('composition', 5))
    expect(show(ed.state.doc)).toBe('ab{+かな}')
  })

  it('composing over untracked text deletes it and inserts after it', () => {
    const ed = make([p(t('ab'))])
    ed.view.dispatch(ed.state.tr.insertText('ア', 2, 3).setMeta('composition', 2))
    expect(show(ed.state.doc)).toBe('a{-b}{+ア}')
  })
})

describe('paragraphs', () => {
  it('Enter splits with an inserted boundary; reject joins it back', () => {
    const ed = make([p(t('abcd'))])
    at(ed, 3)
    key(ed, 'Enter')
    expect(show(ed.state.doc)).toBe('ab | +¶cd')
    type(ed, 'X')
    expect(show(ed.state.doc)).toBe('ab | +¶{+X}cd')
    expect(ids(ed)).toHaveLength(1) // typing at the start of the new paragraph: the same change
    apply(ed, rejectAll(ed.state))
    expect(show(ed.state.doc)).toBe('abcd')
  })

  it('Enter at the end, then typing a new paragraph: hidden in Original, removed on reject', () => {
    const ed = make([p(t('ab'))])
    at(ed, 3)
    key(ed, 'Enter')
    type(ed, 'new')
    expect(show(ed.state.doc)).toBe('ab | +¶{+new}')
    expect(ids(ed)).toHaveLength(1) // the new paragraph and its text: one change
    apply(ed, rejectAll(ed.state))
    expect(show(ed.state.doc)).toBe('ab')
  })

  it('Backspace at the start of a paragraph records a deleted boundary; accept joins', () => {
    const ed = make([p(t('ab')), p(t('cd'))])
    at(ed, 5)
    key(ed, 'Backspace')
    expect(show(ed.state.doc)).toBe('ab | -¶cd')
    expect(ed.state.selection.head).toBe(3)
    key(ed, 'Backspace') // goes on deleting before the boundary
    expect(show(ed.state.doc)).toBe('a{-b} | -¶cd')
    apply(ed, acceptAll(ed.state))
    expect(show(ed.state.doc)).toBe('acd')
  })

  it('Backspace at the start of a paragraph whose boundary is already deleted goes on before it', () => {
    const ed = make([p(t('ab')), p(t('cd'))])
    at(ed, 5)
    key(ed, 'Backspace')
    at(ed, 5)
    key(ed, 'Backspace')
    expect(show(ed.state.doc)).toBe('a{-b} | -¶cd')
  })

  it('removing your own inserted boundary really joins', () => {
    const ed = make([p(t('abcd'))])
    at(ed, 3)
    key(ed, 'Enter')
    key(ed, 'Backspace')
    expect(show(ed.state.doc)).toBe('abcd')
  })

  it('deleting a whole paragraph: all text deleted and its boundary; accept removes it', () => {
    const ed = make([p(t('one')), p(t('two')), p(t('three'))])
    ed.view.dispatch(ed.state.tr.delete(4, 9)) // end of "one" .. end of "two"
    expect(show(ed.state.doc)).toBe('one | -¶{-two} | three')
    apply(ed, acceptAll(ed.state))
    expect(show(ed.state.doc)).toBe('one | three')
  })
})

describe('footnotes and breaks', () => {
  it('Insert Footnote is an inserted reference; deleting one is a deleted reference skipped in No Markup', () => {
    const ed = make([p(t('Claim.'), { type: 'footnote', content: [t('Old note.')] }, t(' End.'))])
    at(ed, 7)
    ed.commands.insertFootnote()
    const doc = ed.state.doc
    expect(show(doc)).toBe('Claim.{+^()}^(Old note.) End.')
    // Delete the old note (selected reference).
    const oldPos = 9
    ed.view.dispatch(ed.state.tr.setSelection(NodeSelection.create(ed.state.doc, oldPos)).deleteSelection())
    expect(show(ed.state.doc)).toBe('Claim.{+^()}{-^(Old note.)} End.')
    const opts = resolveFootnoteOptions({})
    expect(collectFootnotes(ed.state.doc, opts, 'all').map((r) => r.label)).toEqual(['1', '2'])
    expect(collectFootnotes(ed.state.doc, opts, 'none').map((r) => r.label)).toEqual(['1'])
    expect(collectFootnotes(ed.state.doc, opts, 'original').map((r) => r.node.textContent)).toEqual(['Old note.'])
  })

  it('edits inside a note (steps forwarded by the footnote editor) are recorded in the manuscript', () => {
    const ed = make([p(t('A'), { type: 'footnote', content: [t('note')] })])
    // The footnote editor maps its steps by StepMap.offset(pos + 1): here, "!" at the note's end.
    ed.view.dispatch(ed.state.tr.insertText('!', 7))
    ed.view.dispatch(ed.state.tr.delete(3, 4))
    expect(show(ed.state.doc)).toBe('A^({-n}ote{+!})')
  })

  describe('breaks inserted in the middle of a paragraph (split + insert)', () => {
    const cases: [string, (ed: Editor) => void, string][] = [
      ['page break', (ed) => ed.commands.insertPageBreak(), 'ab | +¶[pageBreak] | +¶cd'],
      ['scene break', (ed) => ed.commands.insertSceneBreak('#'), 'ab | +¶[sceneBreak] | +¶cd'],
      ['new chapter', (ed) => ed.commands.insertChapter(), 'ab | +¶ | +¶cd'],
    ]
    for (const [name, insert, tracked] of cases) {
      it(`${name}: reject gives the paragraph back whole, accept keeps the structure`, () => {
        const ed = make([p(t('abcd'))])
        at(ed, 3)
        insert(ed)
        expect(show(ed.state.doc)).toBe(tracked)
        const s0 = ed.state
        apply(ed, rejectAll(ed.state))
        expect(show(ed.state.doc)).toBe('abcd')
        expect(ed.state.doc.childCount).toBe(1)
        expect(ed.state.doc.firstChild!.attrs.styleId ?? null).toBeNull()
        ed.view.updateState(s0)
        apply(ed, acceptAll(ed.state))
        expect(show(ed.state.doc)).toBe(tracked.replace(/\+¶/g, ''))
        expect(listChanges(ed.state.doc)).toHaveLength(0)
      })
    }
  })

  it('page break insert and delete are tracked block changes', () => {
    const ed = make([p(t('ab')), p(t('cd'))])
    at(ed, 3)
    ed.commands.insertPageBreak()
    expect(show(ed.state.doc)).toBe('ab | +¶[pageBreak] | cd')
    apply(ed, rejectAll(ed.state))
    expect(show(ed.state.doc)).toBe('ab | cd')
    useStore.getState().bookActions.setTrackChanges(false)
    ed.commands.insertPageBreak()
    useStore.getState().bookActions.setTrackChanges(true)
    const pb = ed.state.doc.child(1)
    expect(pb.type.name).toBe('pageBreak')
    ed.view.dispatch(ed.state.tr.setSelection(NodeSelection.create(ed.state.doc, 4)).deleteSelection())
    expect(show(ed.state.doc)).toBe('ab | -¶[pageBreak] | cd')
    apply(ed, acceptAll(ed.state))
    expect(show(ed.state.doc)).toBe('ab | cd')
  })
})

describe('formatting', () => {
  it('bold is a format change holding the earlier marks; reverting it removes the change', () => {
    const ed = make([p(t('one two'))])
    ed.commands.setTextSelection({ from: 1, to: 4 })
    ed.commands.toggleBold()
    expect(show(ed.state.doc)).toBe('{~one} two')
    const fc = ed.state.doc.firstChild!.firstChild!.marks.find((m) => m.type.name === 'formatChange')!
    expect(fc.attrs).toMatchObject({ author: 'Ann', before: [] })
    ed.commands.toggleBold()
    expect(show(ed.state.doc)).toBe('one two')
  })

  it('reject restores the earlier formatting', () => {
    const ed = make([p(t('one', [{ type: 'italic' }]), t(' two'))])
    ed.commands.setTextSelection({ from: 1, to: 8 })
    ed.commands.toggleBold()
    apply(ed, rejectAll(ed.state))
    expect(ed.state.doc.firstChild!.content.toJSON()).toEqual([t('one', [{ type: 'italic' }]), t(' two')])
  })

  it('formatting your own insertion is not a separate change', () => {
    const ed = make([p(t('a'))])
    at(ed, 2)
    type(ed, 'bc')
    ed.commands.setTextSelection({ from: 2, to: 4 })
    ed.commands.toggleBold()
    expect(show(ed.state.doc)).toBe('a{+bc}')
  })

  it('a paragraph style change (setNodeMarkup) records the earlier style; reject restores it', () => {
    const ed = make([p(t('Title'))])
    at(ed, 2)
    ed.commands.setBlockStyle(STYLE_IDS.chapterTitle)
    const node = ed.state.doc.firstChild!
    expect(node.type.name).toBe('heading')
    expect(node.attrs.trackedStyleChange).toMatchObject({ author: 'Ann', beforeStyleId: null, beforeType: 'paragraph' })
    apply(ed, rejectAll(ed.state))
    expect(ed.state.doc.firstChild!.type.name).toBe('paragraph')
    expect(ed.state.doc.firstChild!.attrs.trackedStyleChange).toBeNull()
  })

  it('alignment (block formatting) is tracked too; accept keeps it', () => {
    const ed = make([p(t('x'))])
    at(ed, 1)
    ed.commands.setTextAlign('center')
    expect(ed.state.doc.firstChild!.attrs.trackedStyleChange).not.toBeNull()
    apply(ed, acceptAll(ed.state))
    expect(ed.state.doc.firstChild!.attrs).toMatchObject({ textAlign: 'center', trackedStyleChange: null })
  })
})

describe('undo', () => {
  it('one user edit (with its rewrite) is one undo step; undo restores text and marks', () => {
    const ed = make([p(t('abc'))])
    at(ed, 4)
    key(ed, 'Backspace')
    expect(show(ed.state.doc)).toBe('ab{-c}')
    undo(ed.state, ed.view.dispatch)
    expect(show(ed.state.doc)).toBe('abc')
    expect(ed.can().undo()).toBe(false)
  })

  it('accept / reject are undoable and never recorded as changes', () => {
    const ed = make([p(t('abc'))])
    at(ed, 4)
    type(ed, 'd')
    const id = ids(ed)[0]
    apply(ed, acceptChange(ed.state, id))
    expect(show(ed.state.doc)).toBe('abcd')
    undo(ed.state, ed.view.dispatch)
    expect(show(ed.state.doc)).toBe('abc{+d}')
  })

  it('a rewrite that fails applies the edit untracked and shows a status-bar warning', () => {
    const ed = make([p(t('abc'))])
    brokenAuthor = true
    const err = console.error
    console.error = () => {}
    try {
      at(ed, 4)
      type(ed, 'd')
    } finally {
      console.error = err
      brokenAuthor = false
    }
    expect(show(ed.state.doc)).toBe('abcd')
    expect(useStore.getState().trackChanges.notice).toBe(TRACK_FAILED_NOTICE)
    setTracking(false) // turning Track Changes off (or on) clears it
    expect(useStore.getState().trackChanges.notice).toBeNull()
  })

  it('transactions marked to be skipped are applied as they are', () => {
    const ed = make([p(t('abc'))])
    ed.view.dispatch(ed.state.tr.insertText('Z', 1).setMeta(TRACK_SKIP_META, true))
    expect(show(ed.state.doc)).toBe('Zabc')
  })
})

describe('view-aware text', () => {
  it('blockPlainText leaves out what the view hides', () => {
    const ed = make([p(t('Old', [{ type: 'deletion', attrs: { id: 'd', author: 'A' } }]), t('New', [{ type: 'insertion', attrs: { id: 'i', author: 'A' } }]), t(' Title'))])
    const block = ed.state.doc.firstChild!
    expect(blockPlainText(block)).toBe('OldNew Title')
    expect(blockPlainText(block, { markupView: 'none' })).toBe('New Title')
    expect(blockPlainText(block, { markupView: 'original' })).toBe('Old Title')
  })
})
