import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { TextSelection } from '@tiptap/pm/state'
import { useStore } from '@/shared/store'
import { getDocJSON, getEditor, NovelEditor, setDocJSON } from '../index'
import type { Editor, JSONContent } from '../index'
import { installLayoutPolyfills } from '../jsdom-polyfills.test-util'
import { chapterIndexAt, getChapters } from './chapters'
import { getChaptersStartOn, setChaptersStartOn } from './chapter-start'
import { mapPastedHtml } from './paste'
import { blockPlainText } from '../block-text'
import { getFootnotes } from '../footnote/api'
import { createStyle, duplicateStyle, getStyleDefinition, ownDef, saveStyle } from '../styles/actions'
import { getResolvedStyles } from '../styles/resolved'

beforeAll(installLayoutPolyfills)
afterEach(() => {
  cleanup()
  act(() => useStore.getState().bookActions.resetBook())
  setDocJSON({ type: 'doc', content: [{ type: 'paragraph' }] })
})

const p = (text: string, attrs?: Record<string, unknown>): JSONContent => ({
  type: 'paragraph',
  ...(attrs ? { attrs } : {}),
  ...(text ? { content: [{ type: 'text', text }] } : {}),
})
const h = (text: string, attrs?: Record<string, unknown>): JSONContent => ({
  type: 'heading',
  attrs: { level: 1, ...attrs },
  ...(text ? { content: [{ type: 'text', text }] } : {}),
})

function mount(content: JSONContent[]): Editor {
  render(<NovelEditor />)
  setDocJSON({ type: 'doc', content })
  return getEditor()!
}
const run = (fn: () => unknown) => act(() => void fn())
const types = (ed: Editor) => ed.state.doc.content.content.map((n) => n.type.name)
const blocks = (ed: Editor) => Array.from(ed.view.dom.children) as HTMLElement[]
function caret(ed: Editor, pos: number) {
  act(() => void ed.view.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, pos))))
}
function type(ed: Editor, text: string) {
  for (const ch of text) {
    act(() => {
      const { from, to } = ed.state.selection
      if (!ed.view.someProp('handleTextInput', (f) => f(ed.view, from, to, ch, () => ed.state.tr.insertText(ch, from, to)))) {
        ed.view.dispatch(ed.state.tr.insertText(ch, from, to))
      }
    })
  }
}
function key(ed: Editor, k: string, mods: { ctrl?: boolean; alt?: boolean; shift?: boolean }) {
  act(() => {
    ed.view.dom.dispatchEvent(
      new KeyboardEvent('keydown', { key: k, ctrlKey: !!mods.ctrl, altKey: !!mods.alt, shiftKey: !!mods.shift, bubbles: true, cancelable: true }),
    )
  })
}

describe('getChapters', () => {
  it('derives chapters from Chapter Title blocks, with front matter before the first', () => {
    const ed = mount([p('Dedication'), h('One'), p('a'), h('Two'), p('b'), p('c')])
    const doc = ed.state.doc
    const chapters = getChapters(doc)
    expect(chapters.map((c) => [c.index, c.title])).toEqual([[0, 'One'], [1, 'Two']])
    const start = (i: number) => doc.content.content.slice(0, i).reduce((n, b) => n + b.nodeSize, 0)
    expect(chapters[0]).toMatchObject({ from: start(1), to: start(3) })
    expect(chapters[1]).toMatchObject({ from: start(3), to: doc.content.size })
    expect(chapterIndexAt(chapters, 2)).toBe(-1)
    expect(chapterIndexAt(chapters, start(2))).toBe(0)
    expect(chapterIndexAt(chapters, doc.content.size)).toBe(1)
  })
  it('counts styled paragraphs, includes a Chapter Number in its chapter, ignores Subheadings', () => {
    const ed = mount([
      p('Chapter 1', { styleId: 'chapter-number' }),
      h('Title', { styleId: 'chapter-title' }),
      h('Sub', { level: 2 }),
      p('text'),
    ])
    const chapters = getChapters(ed.state.doc)
    expect(chapters).toHaveLength(1)
    expect(chapters[0]).toMatchObject({ index: 0, title: 'Title', from: 0 })
  })
  it('returns nothing for a document without chapters', () => {
    const ed = mount([p('only text')])
    expect(getChapters(ed.state.doc)).toEqual([])
    expect(chapterIndexAt([], 3)).toBe(-1)
  })
})

const fn = (text: string): JSONContent => ({ type: 'footnote', content: [{ type: 'text', text }] })

describe('blockPlainText (footnote text is not part of the text of a block)', () => {
  it('skips footnote nodes, keeps the text around them', () => {
    const ed = mount([h('', { styleId: 'chapter-title' })])
    run(() =>
      setDocJSON({ type: 'doc', content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'The Road' }, fn('First told in 1902.'), { type: 'text', text: ' Home' }] }, p('x')] }),
    )
    const title = ed.state.doc.child(0)
    expect(title.textContent).toBe('The RoadFirst told in 1902. Home') // what leaked before
    expect(blockPlainText(title)).toBe('The Road Home')
    expect(blockPlainText(ed.state.doc.child(1))).toBe('x')
  })

  it('REGRESSION: a chapter title with a footnote has the title text only', () => {
    const ed = mount([{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'One' }, fn('A note on one.')] }, p('a')])
    expect(getChapters(ed.state.doc).map((c) => c.title)).toEqual(['One'])
  })
})

describe('custom chapter styles (based on Chapter Title)', () => {
  /** A duplicate of a built-in, as Manage styles makes it. */
  const dup = (id: string) => {
    let copy = ''
    run(() => (copy = duplicateStyle(id)!))
    return copy
  }

  it('REGRESSION: a block in a Duplicate of Chapter Title opens a chapter; a Chapter Number duplicate joins it', () => {
    const title = dup('chapter-title')
    const number = dup('chapter-number')
    const ed = mount([
      p('Front'),
      h('One'),
      p('a'),
      h('Two', { styleId: title }),
      p('b'),
      h('3', { styleId: number }),
      h('Three', { styleId: title }),
      p('c'),
    ])
    const doc = ed.state.doc
    const start = (i: number) => doc.content.content.slice(0, i).reduce((n, b) => n + b.nodeSize, 0)
    expect(getChapters(doc).map((c) => [c.title, c.from])).toEqual([
      ['One', start(1)],
      ['Two', start(3)],
      ['Three', start(5)],
    ])
  })

  it.each([
    ['built-in Number', 'built-in Title'],
    ['built-in Number', 'Title copy'],
    ['Number copy', 'built-in Title'],
    ['Number copy', 'Title copy'],
  ])('REGRESSION: %s followed by %s breaks once, before the number (page and recto)', (numberKind, titleKind) => {
    const number = numberKind === 'Number copy' ? dup('chapter-number') : 'chapter-number'
    const title = titleKind === 'Title copy' ? dup('chapter-title') : 'chapter-title'
    const ed = mount([p('Front'), h('3', { styleId: number }), h('The Road', { styleId: title }), p('a')])
    expect(getChapters(ed.state.doc).map((c) => c.title)).toEqual(['The Road'])
    expect(blocks(ed).map((b) => b.getAttribute('data-break-before'))).toEqual([null, 'page', null, null])
    act(() => setChaptersStartOn('recto'))
    expect(blocks(ed).map((b) => b.getAttribute('data-break-before'))).toEqual([null, 'recto', null, null])
  })

  it('REGRESSION: the number-title group follows a role change with no break change (Based on re-pointed)', () => {
    const title = dup('chapter-title')
    const ed = mount([p('Front'), h('3', { styleId: 'chapter-number' }), h('The Road', { styleId: title }), p('a')])
    expect(blocks(ed).map((b) => b.getAttribute('data-break-before'))).toEqual([null, 'page', null, null])
    // Based on Part Title: still breaks before (own copied setting), but is no longer a chapter title.
    run(() => saveStyle(title, { ...ownDef(getStyleDefinition(title)!), basedOn: 'part-title' }))
    expect(blocks(ed).map((b) => b.getAttribute('data-break-before'))).toEqual([null, 'page', 'page', null])
  })

  it('the rule: a chapter style at outline level 1 whose Based on chain reaches Chapter Title (or Chapter Number)', () => {
    const viaChain = createStyle('chapter-title', 'Prologue Title') // based on Chapter Title
    const level2 = createStyle('chapter-title', 'Chapter Subtitle')
    run(() => saveStyle(level2, { ...ownDef(getStyleDefinition(level2)!), outlineLevel: 2 }))
    const asParagraph = createStyle('chapter-title', 'Title-like paragraph')
    run(() => saveStyle(asParagraph, { ...ownDef(getStyleDefinition(asParagraph)!), kind: 'paragraph' }))
    const part = dup('part-title')
    const ed = mount([
      h('P', { styleId: viaChain }),
      h('Sub', { level: 2, styleId: level2 }),
      p('Para', { styleId: asParagraph }),
      h('Part One', { styleId: part }),
      h('Part Two', { styleId: 'part-title' }),
    ])
    expect(getChapters(ed.state.doc).map((c) => c.title)).toEqual(['P'])
    // Re-pointing a style's Based on changes what it is, with no document change.
    run(() => saveStyle(viaChain, { ...ownDef(getStyleDefinition(viaChain)!), basedOn: 'body' }))
    expect(getChapters(ed.state.doc)).toEqual([])
  })

  it('REGRESSION: per-chapter footnote numbering restarts at a Duplicate of Chapter Title, and follows a style change', () => {
    const title = dup('chapter-title')
    run(() => useStore.getState().bookActions.setFootnotes((f) => ({ ...f, numbering: 'chapter' })))
    const ed = mount([
      h('One'),
      { type: 'paragraph', content: [{ type: 'text', text: 'a' }, fn('n1'), fn('n2')] },
      h('Two', { styleId: title }),
      { type: 'paragraph', content: [{ type: 'text', text: 'b' }, fn('n3')] },
    ])
    expect(ed).toBeTruthy()
    expect(getFootnotes().map((r) => r.label)).toEqual(['1', '2', '1'])
    // The duplicate stops being a chapter style (no document change): numbering follows at once.
    run(() => saveStyle(title, { ...ownDef(getStyleDefinition(title)!), basedOn: 'part-title' }))
    expect(getFootnotes().map((r) => r.label)).toEqual(['1', '2', '3'])
  })

  it('REGRESSION: Chapters start on rewrites every chapter-opening style that breaks', () => {
    const title = dup('chapter-title')
    const quiet = createStyle('chapter-title', 'No break title')
    run(() => saveStyle(quiet, { ...ownDef(getStyleDefinition(quiet)!), breakBefore: 'none' }))
    const ed = mount([p('a'), h('One'), p('b'), h('Two', { styleId: title }), p('c'), h('Three', { styleId: quiet })])
    act(() => setChaptersStartOn('recto'))
    const styles = getResolvedStyles()
    expect(styles.get('chapter-title')?.breakBefore).toBe('recto')
    expect(styles.get(title)?.breakBefore).toBe('recto')
    expect(styles.get(quiet)?.breakBefore).toBe('none')
    expect(styles.get('part-title')?.breakBefore).toBe('recto')
    expect(blocks(ed).map((b) => b.getAttribute('data-break-before'))).toEqual([null, 'recto', null, 'recto', null, null])
    act(() => setChaptersStartOn('page'))
    expect(getResolvedStyles().get(title)?.breakBefore).toBe('page')
    expect(getResolvedStyles().get('part-title')?.breakBefore).toBe('recto')
  })
})

describe('page break', () => {
  it('Mod-Enter inserts a node, the following block carries data-break-before=page, delete removes it', () => {
    const ed = mount([p('one'), p('two')])
    caret(ed, 4) // end of "one"
    key(ed, 'Enter', { ctrl: true })
    expect(types(ed)).toEqual(['paragraph', 'pageBreak', 'paragraph'])
    const dom = blocks(ed)
    expect(dom[0].hasAttribute('data-break-before')).toBe(false)
    expect(dom[1].hasAttribute('data-page-break')).toBe(true)
    expect(dom[2].getAttribute('data-break-before')).toBe('page')
    run(() => ed.commands.setNodeSelection(ed.state.doc.child(0).nodeSize))
    run(() => ed.commands.deleteSelection())
    expect(types(ed)).toEqual(['paragraph', 'paragraph'])
    expect(blocks(ed).some((b) => b.hasAttribute('data-break-before'))).toBe(false)
  })
  it('splits a block when inserted mid-text', () => {
    const ed = mount([p('abcd')])
    caret(ed, 3)
    run(() => ed.commands.insertPageBreak())
    expect(types(ed)).toEqual(['paragraph', 'pageBreak', 'paragraph'])
    expect(ed.state.doc.child(0).textContent).toBe('ab')
    expect(ed.state.doc.child(2).textContent).toBe('cd')
  })
  it('a page break before a recto-breaking block stays recto', () => {
    const ed = mount([p('a'), { type: 'pageBreak' }, h('Part', { styleId: 'part-title' })])
    expect(blocks(ed)[2].getAttribute('data-break-before')).toBe('recto')
  })
  it('appends a paragraph when inserted at the end', () => {
    const ed = mount([p('a')])
    caret(ed, 2)
    run(() => ed.commands.insertPageBreak())
    expect(types(ed)).toEqual(['paragraph', 'pageBreak', 'paragraph'])
    expect(ed.state.selection.$from.parent.type.name).toBe('paragraph')
  })
  it('survives a JSON round trip', () => {
    const content = [p('a'), { type: 'pageBreak' }, p('b')]
    mount(content)
    expect(getDocJSON()).toEqual({ type: 'doc', content })
  })
})

describe('New chapter', () => {
  it('turns an empty paragraph into a Chapter Title (one undo)', () => {
    const ed = mount([p('text'), p('')])
    caret(ed, 7)
    key(ed, 'Enter', { ctrl: true, shift: true })
    expect(ed.state.doc.child(1).attrs).toMatchObject({ level: 1, styleId: 'chapter-title' })
    expect(blocks(ed)[1].getAttribute('data-break-before')).toBe('page')
    run(() => ed.commands.undo())
    expect(ed.state.doc.child(1).type.name).toBe('paragraph')
  })
  it('inserts a title after the current block, or splits mid-text', () => {
    const ed = mount([p('abcd')])
    caret(ed, 3)
    run(() => ed.commands.insertChapter())
    expect(types(ed)).toEqual(['paragraph', 'heading', 'paragraph'])
    expect(ed.state.doc.child(1).attrs.styleId).toBe('chapter-title')
    expect(ed.state.selection.$from.parent.type.name).toBe('heading')
    expect(getChapters(ed.state.doc)).toHaveLength(1)
  })
  it('Chapters start on right-hand page rewrites the Chapter Title style', () => {
    const ed = mount([p('a'), h('One')])
    expect(getChaptersStartOn()).toBe('page')
    expect(blocks(ed)[1].getAttribute('data-break-before')).toBe('page')
    act(() => setChaptersStartOn('recto'))
    expect(getChaptersStartOn()).toBe('recto')
    expect(blocks(ed)[1].getAttribute('data-break-before')).toBe('recto')
    act(() => setChaptersStartOn('page'))
    expect(blocks(ed)[1].getAttribute('data-break-before')).toBe('page')
  })
})

describe('scene break', () => {
  it('Mod-Alt-Enter inserts a centred scene break and the next paragraph uses First Paragraph', () => {
    const ed = mount([p('one'), p('two')])
    caret(ed, 4)
    key(ed, 'Enter', { ctrl: true, alt: true })
    expect(types(ed)).toEqual(['paragraph', 'sceneBreak', 'paragraph'])
    expect(ed.state.doc.child(2).attrs.styleId).toBe('first-paragraph')
    const sb = blocks(ed)[1]
    expect(sb.dataset.style).toBe('scene-break')
    expect(sb.textContent).toBe('* * *')
    expect(sb.hasAttribute('data-break-before')).toBe(false)
  })
  it('supports the other ornaments and changing the selected one', () => {
    const ed = mount([p('one')])
    caret(ed, 4)
    run(() => ed.commands.insertSceneBreak('❦'))
    expect(blocks(ed)[1].textContent).toBe('❦')
    run(() => ed.commands.setNodeSelection(ed.state.doc.child(0).nodeSize))
    run(() => ed.commands.setSceneBreakOrnament(''))
    expect(ed.state.doc.child(1).attrs.ornament).toBe('')
    expect(blocks(ed)[1].dataset.ornament).toBe('')
  })
  it.each([
    ['***', '* * *'],
    ['###', '#'],
  ])('typing %s alone converts it, and one undo reverts it', (typed, ornament) => {
    const ed = mount([p('text'), p('')])
    caret(ed, 7)
    type(ed, typed)
    expect(types(ed)).toEqual(['paragraph', 'sceneBreak', 'paragraph'])
    expect(ed.state.doc.child(1).attrs.ornament).toBe(ornament)
    expect(ed.state.doc.child(2).attrs.styleId).toBe('first-paragraph')
    run(() => ed.commands.undo())
    expect(types(ed)).toEqual(['paragraph', 'paragraph'])
  })
  it('does not convert when other text is on the line', () => {
    const ed = mount([p('a**')])
    caret(ed, 4)
    type(ed, '*')
    expect(types(ed)).toEqual(['paragraph'])
  })
})

describe('paste mapping', () => {
  it('maps page-break-before and break-before to a page break node before the element', () => {
    expect(mapPastedHtml('<p>a</p><p style="page-break-before: always">b</p>')).toBe(
      '<p>a</p><div data-page-break=""></div><p style="page-break-before: always">b</p>',
    )
    expect(mapPastedHtml('<h1 style="color:red;break-before:page">T</h1>')).toContain('<div data-page-break=""></div><h1')
  })
  it('maps page-break-after to a node after the element', () => {
    expect(mapPastedHtml('<p style="page-break-after:always">a</p>')).toMatch(/<\/p><div data-page-break=""><\/div>$/)
  })
  it('leaves other HTML alone', () => {
    const html = '<p style="color:red">a</p>'
    expect(mapPastedHtml(html)).toBe(html)
    expect(mapPastedHtml('<p>break-before in text</p>')).toBe('<p>break-before in text</p>')
  })
  it('parses the mapped HTML and <hr> into page and scene breaks', () => {
    const ed = mount([p('x')])
    const mapped = mapPastedHtml('<p>a</p><p style="page-break-before: always">b</p><hr><p>c</p>')
    run(() => ed.commands.setContent(mapped))
    expect(types(ed)).toEqual(['paragraph', 'pageBreak', 'paragraph', 'sceneBreak', 'paragraph'])
    expect(ed.state.doc.child(3).attrs.ornament).toBe('* * *')
  })
})
