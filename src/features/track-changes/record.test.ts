import { Editor, type JSONContent } from '@tiptap/core'
import { Fragment, Slice, type Node as PMNode } from '@tiptap/pm/model'
import { NodeSelection, TextSelection } from '@tiptap/pm/state'
import { undo } from '@tiptap/pm/history'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { STYLE_IDS } from '@/shared/book'
import { useStore } from '@/shared/store'
import { createEditorExtensions, blockPlainText, collectFootnotes } from '@/features/editor'
import { resolveFootnoteOptions } from '@/shared/book'
import { acceptAll, rejectAll, acceptChange, rejectChange, listChanges } from './review'
import { resetTrackingSession, TRACK_SKIP_META, trackTransaction } from './record'
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
    const ed = make([p(t('abc'))])
    const composing = composingFlag(ed)
    composing(true)
    // The IME replaces the selected "b": the deletion mark goes on at once, the composed text stays unmarked.
    ed.view.dispatch(ed.state.tr.insertText('ア', 2, 3).setMeta('composition', 2))
    expect(show(ed.state.doc)).toBe('a{-b}アc')
    expect(ed.view.dom.querySelector('.nv-del')?.textContent).toBe('b')
    expect(ed.view.dom.querySelector('.nv-ins')).toBeNull()
    ed.view.dispatch(ed.state.tr.insertText('アイ', 3, 4).setMeta('composition', 2))
    expect(show(ed.state.doc)).toBe('a{-b}アイc')
    composing(false)
    ed.view.dispatch(ed.state.tr.insertText('愛', 3, 5).setMeta('composition', 2))
    expect(show(ed.state.doc)).toBe('a{-b}{+愛}c')
    undo(ed.state, ed.view.dispatch)
    expect(show(ed.state.doc)).toBe('abc')
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

describe('list items (the boundary before a textblock runs from the previous textblock, whatever the nesting)', () => {
  const li = (...content: JSONContent[]): JSONContent => ({ type: 'listItem', content })
  const ul = (...items: JSONContent[]): JSONContent => ({ type: 'bulletList', content: items })
  const item = (text: string) => li(p(t(text)))
  /** The structure: `ul[A, B]`, an item's paragraphs joined by " / ", top-level blocks by " | ". */
  function tree(n: PMNode): string {
    if (n.isTextblock) return n.textContent
    const kids: string[] = []
    n.forEach((c) => kids.push(tree(c)))
    if (n.type.name === 'doc') return kids.join(' | ')
    if (n.type.name === 'listItem') return kids.join(' / ')
    return `${n.type.name === 'bulletList' ? 'ul' : n.type.name}[${kids.join(', ')}]`
  }
  /** Position just after the first occurrence of `s` in the document's text. */
  function after(ed: Editor, s: string): number {
    let found = -1
    ed.state.doc.descendants((n, pos) => {
      if (found >= 0) return false
      if (n.isText && n.text!.includes(s)) found = pos + n.text!.indexOf(s) + s.length
      return true
    })
    if (found < 0) throw new Error(`no ${s}`)
    return found
  }
  const before = (ed: Editor, s: string) => after(ed, s) - s.length

  it('Enter at the end of an item, Reject All: the new empty item goes', () => {
    const ed = make([ul(item('Apple'), item('Pear'))])
    at(ed, after(ed, 'Apple'))
    key(ed, 'Enter')
    expect(show(ed.state.doc)).toBe('Apple | +¶ | Pear')
    expect(tree(ed.state.doc)).toBe('ul[Apple, , Pear]')
    apply(ed, rejectAll(ed.state))
    expect(tree(ed.state.doc)).toBe('ul[Apple, Pear]')
  })

  it('Enter inside an item, Reject All: the halves join again; Accept All keeps the split', () => {
    const ed = make([ul(item('ApPle'), item('Pear'))])
    at(ed, after(ed, 'Ap'))
    key(ed, 'Enter')
    expect(show(ed.state.doc)).toBe('Ap | +¶Ple | Pear')
    const s0 = ed.state
    apply(ed, rejectAll(ed.state))
    expect(tree(ed.state.doc)).toBe('ul[ApPle, Pear]')
    ed.view.updateState(s0)
    apply(ed, acceptAll(ed.state))
    expect(tree(ed.state.doc)).toBe('ul[Ap, Ple, Pear]')
    expect(listChanges(ed.state.doc)).toHaveLength(0)
  })

  it('a deleted item (end of the one before to its end), Accept All: the item goes; Reject All keeps it', () => {
    const ed = make([ul(item('Apple'), item('Pear'), item('Plum'))])
    ed.view.dispatch(ed.state.tr.delete(after(ed, 'Apple'), after(ed, 'Pear')))
    expect(show(ed.state.doc)).toBe('Apple | -¶{-Pear} | Plum')
    const s0 = ed.state
    apply(ed, acceptAll(ed.state))
    expect(tree(ed.state.doc)).toBe('ul[Apple, Plum]')
    ed.view.updateState(s0)
    apply(ed, rejectAll(ed.state))
    expect(tree(ed.state.doc)).toBe('ul[Apple, Pear, Plum]')
  })

  it('a pasted two-item list inside a paragraph, Reject All: the list goes and the paragraph is whole again', () => {
    const ed = make([p(t('xy'))])
    at(ed, 2)
    const s = ed.schema
    const list = s.nodes.bulletList.create(null, [
      s.nodes.listItem.create(null, s.nodes.paragraph.create(null, s.text('P'))),
      s.nodes.listItem.create(null, s.nodes.paragraph.create(null, s.text('Q'))),
    ])
    ed.view.dispatch(ed.state.tr.replaceSelection(new Slice(Fragment.from(list), 0, 0)))
    expect(tree(ed.state.doc)).toBe('x | ul[P, Q] | y')
    expect(show(ed.state.doc)).toBe('x | +¶{+P} | +¶{+Q} | +¶y')
    const s0 = ed.state
    apply(ed, rejectAll(ed.state))
    expect(tree(ed.state.doc)).toBe('xy')
    ed.view.updateState(s0)
    apply(ed, acceptAll(ed.state))
    expect(tree(ed.state.doc)).toBe('x | ul[P, Q] | y')
  })

  it('a whole list deleted, Accept All: the list goes; Reject All: it is back', () => {
    const ed = make([p(t('Intro')), ul(item('Apple'), item('Pear')), p(t('Outro'))])
    ed.view.dispatch(ed.state.tr.delete(after(ed, 'Intro'), after(ed, 'Pear')))
    expect(show(ed.state.doc)).toBe('Intro | -¶{-Apple} | -¶{-Pear} | Outro')
    const s0 = ed.state
    apply(ed, acceptAll(ed.state))
    expect(tree(ed.state.doc)).toBe('Intro | Outro')
    ed.view.updateState(s0)
    apply(ed, rejectAll(ed.state))
    expect(tree(ed.state.doc)).toBe('Intro | ul[Apple, Pear] | Outro')
  })

  it('Backspace at the start of an item records a deleted boundary (never a lost keystroke); accept joins, reject keeps', () => {
    const ed = make([ul(item('Apple'), item('Pear'))])
    at(ed, before(ed, 'Pear'))
    key(ed, 'Backspace')
    expect(show(ed.state.doc)).toBe('Apple | -¶Pear')
    expect(ed.state.selection.head).toBe(after(ed, 'Apple')) // before the deleted boundary
    key(ed, 'Backspace') // goes on before it
    expect(show(ed.state.doc)).toBe('Appl{-e} | -¶Pear')
    const s0 = ed.state
    apply(ed, acceptAll(ed.state))
    expect(tree(ed.state.doc)).toBe('ul[ApplPear]')
    ed.view.updateState(s0)
    apply(ed, rejectAll(ed.state))
    expect(tree(ed.state.doc)).toBe('ul[Apple, Pear]')
  })

  it('Delete at the end of an item records the boundary before the next one and moves past it', () => {
    const ed = make([ul(item('Apple'), item('Pear'))])
    at(ed, after(ed, 'Apple'))
    key(ed, 'Delete')
    expect(show(ed.state.doc)).toBe('Apple | -¶Pear')
    expect(ed.state.selection.head).toBe(before(ed, 'Pear'))
    apply(ed, acceptAll(ed.state))
    expect(tree(ed.state.doc)).toBe('ul[ApplePear]')
  })

  it('Backspace in an item you just made removes it for real; so does Delete before it', () => {
    const ed = make([ul(item('Apple'), item('Pear'))])
    at(ed, after(ed, 'Apple'))
    key(ed, 'Enter')
    key(ed, 'Backspace')
    expect(tree(ed.state.doc)).toBe('ul[Apple, Pear]')
    expect(listChanges(ed.state.doc)).toHaveLength(0)
    expect(ed.state.selection.head).toBe(after(ed, 'Apple'))
    key(ed, 'Enter')
    at(ed, after(ed, 'Apple'))
    key(ed, 'Delete')
    expect(tree(ed.state.doc)).toBe('ul[Apple, Pear]')
    expect(listChanges(ed.state.doc)).toHaveLength(0)
  })

  it('a split you made inside an item, then Backspace: joined again, no change left', () => {
    const ed = make([ul(item('ApPle'))])
    at(ed, after(ed, 'Ap'))
    key(ed, 'Enter')
    key(ed, 'Backspace')
    expect(tree(ed.state.doc)).toBe('ul[ApPle]')
    expect(listChanges(ed.state.doc)).toHaveLength(0)
  })

  it('selecting your own new item and deleting it removes it for real', () => {
    const ed = make([ul(item('Apple'), item('Pear'))])
    at(ed, after(ed, 'Apple'))
    key(ed, 'Enter')
    type(ed, 'Fig')
    expect(show(ed.state.doc)).toBe('Apple | +¶{+Fig} | Pear')
    ed.view.dispatch(ed.state.tr.delete(after(ed, 'Apple'), after(ed, 'Fig')))
    expect(tree(ed.state.doc)).toBe('ul[Apple, Pear]')
    expect(listChanges(ed.state.doc)).toHaveLength(0)
  })

  it('one undo step for each accept and reject of a list change', () => {
    const ed = make([ul(item('Apple'), item('Pear'))])
    at(ed, after(ed, 'Apple'))
    key(ed, 'Enter')
    const id = ids(ed)[0]
    const s1 = ed.state.doc
    apply(ed, rejectChange(ed.state, id))
    expect(tree(ed.state.doc)).toBe('ul[Apple, Pear]')
    undo(ed.state, ed.view.dispatch)
    expect(ed.state.doc.eq(s1)).toBe(true)
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

  it('Select All + Bold over many paragraphs: one formatChange step spanning them, not one per paragraph', () => {
    const ed = make(Array.from({ length: 50 }, (_, i) => p(t(`Paragraph ${i} text.`))))
    const before = ed.state.doc
    const tr = ed.state.tr
    tr.addMark(0, ed.state.doc.content.size, ed.schema.marks.bold.create())
    const userSteps = tr.steps.length
    expect(userSteps).toBe(50)
    const out = trackTransaction(ed.state, tr, { name: author }, '2026-01-01T00:00:00.000Z')
    expect(out.steps.length).toBe(userSteps + 1)
    ed.view.dispatch(out)
    expect(listChanges(ed.state.doc)).toHaveLength(1)
    ed.state.doc.descendants((n) => {
      if (n.isText) expect(n.marks.map((m) => m.type.name).sort()).toEqual(['bold', 'formatChange'])
    })
    const rejected = rejectAll(ed.state)!
    expect(rejected.doc.eq(before)).toBe(true)
    const accepted = acceptAll(ed.state)!
    // Accept All removes the formatChange marks in one step across the paragraphs too.
    expect(accepted.steps.length).toBe(1)
    accepted.doc.descendants((n) => {
      if (n.isText) expect(n.marks.map((m) => m.type.name)).toEqual(['bold'])
    })
  })

  it('a formatChange span breaks at your own insertion, deleted text, a footnote and a different earlier formatting', () => {
    const ed = make([
      p(t('one '), t('two', [{ type: 'italic' }]), t(' three')),
      p(t('four '), { type: 'footnote', content: [t('note')] }, t(' five')),
      p(t('six seven')),
    ])
    at(ed, 4) // inside "one"
    type(ed, 'X') // your own insertion
    ed.view.dispatch(ed.state.tr.delete(ed.state.doc.firstChild!.nodeSize + 2, ed.state.doc.firstChild!.nodeSize + 3)) // a deleted letter in "four"
    const before = ed.state.doc
    ed.commands.selectAll()
    ed.commands.toggleBold()
    // The footnote reference itself is not marked; its text is.
    let noteMarked = false
    let noteText = false
    ed.state.doc.descendants((n) => {
      if (n.type.name === 'footnote') noteMarked = n.marks.some((m) => m.type.name === 'formatChange')
      // The note's text: a formatChange exactly where its formatting changed.
      if (n.isText && n.text === 'note') noteText = n.marks.some((m) => m.type.name === 'formatChange') === n.marks.some((m) => m.type.name === 'bold')
      if (n.isText && n.marks.some((m) => m.type.name === 'insertion' || m.type.name === 'deletion'))
        expect(n.marks.some((m) => m.type.name === 'formatChange'), n.text!).toBe(false)
    })
    expect(noteMarked).toBe(false)
    expect(noteText).toBe(true)
    const fcs = new Set<string>()
    ed.state.doc.descendants((n) => {
      for (const m of n.marks) if (m.type.name === 'formatChange') fcs.add(JSON.stringify(m.attrs.before))
    })
    expect([...fcs].sort()).toEqual(['[]', '[{"type":"italic"}]'])
    // One edit: one change id.
    expect(listChanges(ed.state.doc).filter((c) => c.kinds.includes('formatChange'))).toHaveLength(1)
    const rejected = rejectAll(ed.state)!
    // Reject restores the formatting (and rejects the insertion and the deletion as well).
    const plain = (d: PMNode) => {
      const out: string[] = []
      d.descendants((n) => void (n.isText && out.push(`${n.text}:${n.marks.map((m) => m.type.name).filter((x) => x !== 'bold').join(',')}`)))
      return out.join(' ')
    }
    expect(rejected.doc.textContent).toBe('one two threefour note fivesix seven')
    expect(plain(rejected.doc)).not.toContain('formatChange')
    expect(before.textContent).toContain('X')
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

  it('a Reject right after typing is its own undo step: undo brings the typed text back', () => {
    const ed = make([p(t('abc'))])
    at(ed, 4)
    type(ed, 'd')
    apply(ed, rejectChange(ed.state, ids(ed)[0]))
    expect(show(ed.state.doc)).toBe('abc')
    undo(ed.state, ed.view.dispatch)
    expect(show(ed.state.doc)).toBe('abc{+d}')
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

describe('Replace All recorded in one pass (batch)', () => {
  /** Every occurrence of `query` inside one textblock's (or note's) text, document order, as the find engine skips all-deleted ones. */
  function occurrences(doc: PMNode, query: string): [number, number][] {
    const out: [number, number][] = []
    doc.descendants((node, pos) => {
      if (!node.inlineContent) return true
      let text = ''
      const at: number[] = []
      node.forEach((c, off) => {
        const s = c.isText ? c.text! : '￼'
        for (let i = 0; i < s.length; i++) at.push(pos + 1 + off + i)
        text += s
      })
      for (let i = text.indexOf(query); i >= 0; i = text.indexOf(query, i + query.length)) out.push([at[i], at[i + query.length - 1] + 1])
      return true
    })
    out.sort((a, b) => a[0] - b[0])
    return out.filter(([a, b]) => {
      let all = true
      doc.nodesBetween(a, b, (n) => {
        if (n.isInline && !n.marks.some((m) => m.type.name === 'deletion')) all = false
        return all
      })
      return !all
    })
  }

  /** The untracked Replace All transaction, as the find engine builds it (last match first, marks of the first character). */
  function replaceAllTr(ed: Editor, query: string, replacement: string) {
    const tr = ed.state.tr
    const ranges = occurrences(ed.state.doc, query)
    for (let i = ranges.length - 1; i >= 0; i--) {
      const [a, b] = ranges[i]
      if (!replacement) tr.delete(a, b)
      else {
        const marks = (tr.doc.nodeAt(a)?.marks ?? []).filter((m) => !['insertion', 'deletion', 'formatChange'].includes(m.type.name))
        tr.replaceWith(a, b, ed.schema.text(replacement, marks))
      }
    }
    return { tr, count: ranges.length }
  }

  /** The document with change ids numbered in order of appearance and dates dropped. */
  function normal(doc: PMNode): string {
    const idMap = new Map<string, string>()
    return JSON.stringify(doc.toJSON(), (k, v) => {
      if (k === 'id' && typeof v === 'string' && v.startsWith('c')) {
        if (!idMap.has(v)) idMap.set(v, `#${idMap.size}`)
        return idMap.get(v)
      }
      return k === 'date' ? undefined : v
    })
  }

  function compare(ed: Editor, query: string, replacement: string) {
    const { tr, count } = replaceAllTr(ed, query, replacement)
    const date = '2026-01-01T00:00:00.000Z'
    const perMatch = trackTransaction(ed.state, tr, { name: author }, date, { batch: false })
    const batched = trackTransaction(ed.state, tr, { name: author }, date, { batch: true })
    expect(batched.getMeta('nvTrackFailed')).toBeUndefined()
    expect(normal(batched.doc)).toBe(normal(perMatch.doc))
    expect(batched.selection.toJSON()).toEqual(perMatch.selection.toJSON())
    return { count, perMatch, batched }
  }

  it('equals the per-match recording: plain text, marks, other changes, a note, a comment', () => {
    const ins = (id: string, who = 'Bob') => ({ type: 'insertion', attrs: { id, author: who, date: '2026-01-01T00:00:00.000Z', authorColor: null } })
    const del = (id: string) => ({ type: 'deletion', attrs: { id, author: 'Bob', date: '2026-01-01T00:00:00.000Z', authorColor: null } })
    const ed = make([
      p(t('the cat and the dog by the sea')),
      p(t('th', [{ type: 'bold' }]), t('e start, '), t('the', [del('d1')]), t(' gone, '), t('the', [ins('i1')]), t(' new')),
      p(t('Claim the'), { type: 'footnote', content: [t('see the note, the end')] }, t(' then the end')),
      p(t('a '), t('the', [{ type: 'comment', attrs: { id: 'k1' } }]), t(' commented, '), t('ththe', [ins('i2')])),
    ])
    const { count, perMatch, batched } = compare(ed, 'the', 'a')
    expect(count).toBeGreaterThan(10)
    // One step per replaced match (the per-match path takes a mark step and an insertion each).
    expect(batched.steps.length).toBeLessThan(perMatch.steps.length)
    expect(batched.steps.length).toBeLessThanOrEqual(count)
  })

  it('positions between matches map exactly through the recorded Replace All', () => {
    const ed = make([p(t(Array.from({ length: 20 }, (_, i) => `the w${i} `).join('')))])
    const { tr, count } = replaceAllTr(ed, 'the', 'a')
    expect(count).toBe(20)
    const batched = trackTransaction(ed.state, tr, { name: author }, '2026-01-01T00:00:00.000Z', { batch: true })
    expect(batched.steps.length).toBe(20)
    const text = ed.state.doc.textContent
    for (let i = 0; i < 20; i++) {
      const word = `w${i}`
      const pos = text.indexOf(`${word} `) + 1
      const from = batched.mapping.map(pos, 1)
      const to = batched.mapping.map(pos + word.length, -1)
      expect(batched.doc.textBetween(from, to), word).toBe(word)
      // Each earlier match kept its deleted "the" and gained "a": one character each, plus this word's own.
      expect(from - pos, word).toBe(i + 1)
    }
  })

  it("equals the per-match recording next to this session's own changes, and with an empty replacement", () => {
    const ed = make([p(t('one the two the three')), p(t('the end'))])
    // Your own insertion (removed for real when replaced) and your own deletion next to a match.
    at(ed, 8)
    type(ed, 'the')
    at(ed, 4)
    key(ed, 'Backspace')
    compare(ed, 'the', 'a')
    compare(ed, 'the', '')
    compare(ed, 'e', 'E')
  })

  it('a batch that fails after applying some steps starts again per match: the same result', () => {
    const ed = make([p(t(Array.from({ length: 20 }, (_, i) => `the w${i} `).join(''))), p(t('and the end'))])
    const { tr } = replaceAllTr(ed, 'the', 'a')
    const date = '2026-01-01T00:00:00.000Z'
    const perMatch = trackTransaction(ed.state, tr, { name: author }, date, { batch: false })
    // The third ReplaceStep the batch tries fails (as a step that does not fit would).
    const proto = Object.getPrototypeOf(ed.state.tr) as { maybeStep: (s: unknown) => { failed: string | null } }
    const real = proto.maybeStep
    let calls = 0
    proto.maybeStep = function (this: unknown, step: unknown) {
      if (++calls === 3) return { failed: 'test' }
      return real.call(this, step)
    }
    let batched
    try {
      batched = trackTransaction(ed.state, tr, { name: author }, date, { batch: true })
    } finally {
      proto.maybeStep = real
    }
    expect(calls).toBeGreaterThan(3) // it went on, per match
    expect(batched.getMeta('nvTrackFailed')).toBeUndefined()
    expect(normal(batched.doc)).toBe(normal(perMatch.doc))
    expect(batched.selection.toJSON()).toEqual(perMatch.selection.toJSON())
  })

  it('falls back to the per-match path when matches touch', () => {
    const ed = make([p(t('aaaa and aa'))])
    const { tr } = replaceAllTr(ed, 'a', 'b')
    expect(tr.steps.length).toBeGreaterThanOrEqual(6)
    compare(ed, 'a', 'b')
  })

  it('a dispatched Replace All of many matches is one undo step and keeps the selection in the document', () => {
    const ed = make(Array.from({ length: 30 }, (_, i) => p(t(`Line ${i}: the fox and the hound.`))))
    const before = ed.state.doc
    const { tr, count } = replaceAllTr(ed, 'the', 'a')
    expect(count).toBe(60)
    ed.view.dispatch(tr)
    expect(show(ed.state.doc).split(' | ')[0]).toBe('Line 0: {-the}{+a} fox and {-the}{+a} hound.')
    // Each match its own deletion and insertion (as in Word): 60 matches, 120 changes.
    expect(listChanges(ed.state.doc).length).toBe(120)
    undo(ed.state, ed.view.dispatch)
    expect(ed.state.doc.eq(before)).toBe(true)
  })

  it('each replaced match is a change of its own: rejecting one leaves the others (batch and per-match)', () => {
    for (const batch of [true, false]) {
      resetTrackingSession()
      const ed = make([p(t('the cat and the dog')), p(t('by the sea'))])
      const { tr } = replaceAllTr(ed, 'the', 'a')
      ed.view.dispatch(trackTransaction(ed.state, tr, { name: author }, undefined, { batch }))
      expect(show(ed.state.doc)).toBe('{-the}{+a} cat and {-the}{+a} dog | by {-the}{+a} sea')
      const changes = listChanges(ed.state.doc)
      expect(changes).toHaveLength(6)
      // Each change covers one match only.
      for (const c of changes) expect(c.to - c.from, `batch ${batch}`).toBeLessThanOrEqual(3)
      const firstIns = changes.find((c) => c.kinds.includes('insertion'))!
      apply(ed, rejectChange(ed.state, firstIns.id))
      expect(show(ed.state.doc)).toBe('{-the} cat and {-the}{+a} dog | by {-the}{+a} sea')
    }
  })

  it('sharedIds (the re-write Keep): one deletion change and one insertion change for the whole edit', () => {
    const ed = make([p(t('the cat and the dog')), p(t('by the sea'))])
    const { tr } = replaceAllTr(ed, 'the', 'a')
    ed.view.dispatch(trackTransaction(ed.state, tr, { name: author }, undefined, { sharedIds: true }))
    expect(listChanges(ed.state.doc)).toHaveLength(2)
  })
})
