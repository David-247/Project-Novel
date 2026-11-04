import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { TextSelection } from '@tiptap/pm/state'
import { useStore } from '@/shared/store'
import { getDocJSON, getEditor, NovelEditor, setDocJSON, Toolbar } from '../index'
import { readToolbarState } from '../toolbar/toolbar-state'
import { renderedStyleId, styleIdsKey } from './block-styles'
import { getResolvedStyles } from './resolved'
import type { Editor, JSONContent } from '../index'
import { installLayoutPolyfills } from '../jsdom-polyfills.test-util'
import { createStyle, deleteStyle, duplicateStyle, renameStyle, saveStyle, getStyleDefinition, ownDef } from './actions'

beforeAll(installLayoutPolyfills)
afterEach(() => {
  cleanup()
  act(() => useStore.getState().bookActions.resetBook())
  setDocJSON({ type: 'doc', content: [{ type: 'paragraph' }] })
})

const p = (text: string, attrs?: Record<string, unknown>): JSONContent => ({
  type: 'paragraph',
  ...(attrs ? { attrs } : {}),
  content: [{ type: 'text', text }],
})
const h = (level: number, text: string, attrs?: Record<string, unknown>): JSONContent => ({
  type: 'heading',
  attrs: { level, ...attrs },
  content: [{ type: 'text', text }],
})

function mount(content: JSONContent[]): Editor {
  render(<NovelEditor />)
  setDocJSON({ type: 'doc', content })
  return getEditor()!
}

/** Caret at the end of top-level block `i`. */
function caretAtEndOf(ed: Editor, i: number) {
  let pos = 0
  for (let k = 0; k < i; k++) pos += ed.state.doc.child(k).nodeSize
  const end = pos + ed.state.doc.child(i).nodeSize - 1
  act(() => void ed.view.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, end))))
}

function key(ed: Editor, k: string, mods: { ctrl?: boolean; alt?: boolean } = {}) {
  act(() => {
    ed.view.dom.dispatchEvent(
      new KeyboardEvent('keydown', { key: k, ctrlKey: !!mods.ctrl, altKey: !!mods.alt, bubbles: true, cancelable: true }),
    )
  })
}

const blocks = (ed: Editor) => Array.from(ed.view.dom.children) as HTMLElement[]
const run = (fn: () => unknown) => act(() => void fn())

describe('Phase 1 migration (rendering mapping)', () => {
  it('maps H1 to Chapter Title, H2/H3 to Subheading, paragraphs to Body; the JSON is unchanged', () => {
    const doc: JSONContent = { type: 'doc', content: [h(1, 'One'), h(2, 'Sub'), h(3, 'Subsub'), p('Text')] }
    const ed = mount(doc.content!)
    expect(blocks(ed).map((b) => [b.tagName, b.dataset.style])).toEqual([
      ['H1', 'chapter-title'],
      ['H2', 'subheading'],
      ['H3', 'subheading'],
      ['P', 'body'],
    ])
    expect(getDocJSON()).toEqual(doc)
    expect(ed.state.doc.child(0).attrs.styleId).toBeNull()
  })
})

describe('setBlockStyle', () => {
  it('turns a paragraph into a Chapter Title heading in one undo step', () => {
    const ed = mount([p('Chapter'), p('Text')])
    caretAtEndOf(ed, 0)
    run(() => ed.commands.setBlockStyle('chapter-title'))
    expect(ed.state.doc.child(0).type.name).toBe('heading')
    expect(ed.state.doc.child(0).attrs).toMatchObject({ level: 1, styleId: 'chapter-title' })
    expect(blocks(ed)[0].dataset.style).toBe('chapter-title')
    run(() => ed.commands.undo())
    expect(ed.state.doc.child(0).type.name).toBe('paragraph')
    expect(ed.state.doc.child(0).attrs.styleId).toBeNull()
  })

  it('is its own undo step, not merged with the typing right before it', () => {
    const ed = mount([p('Chapter')])
    caretAtEndOf(ed, 0)
    run(() => ed.commands.insertContent(' One'))
    run(() => ed.commands.setBlockStyle('chapter-title'))
    run(() => ed.commands.undo())
    expect(ed.state.doc.child(0).type.name).toBe('paragraph')
    expect(ed.state.doc.textContent).toBe('Chapter One')
  })

  it('Mod-Alt-1 / Mod-Alt-0 apply Chapter Title / Body; Body is stored as null', () => {
    const ed = mount([p('Title')])
    caretAtEndOf(ed, 0)
    key(ed, '1', { ctrl: true, alt: true })
    expect(ed.state.doc.child(0).attrs.styleId).toBe('chapter-title')
    key(ed, '0', { ctrl: true, alt: true })
    expect(ed.state.doc.child(0).type.name).toBe('paragraph')
    expect(getDocJSON().content![0]).toEqual(p('Title'))
  })

  it('applies paragraph styles inside lists, but not chapter styles', () => {
    const ed = mount([{ type: 'bulletList', content: [{ type: 'listItem', content: [p('Item')] }] }])
    act(() => void ed.commands.setTextSelection(3))
    expect(ed.commands.setBlockStyle('chapter-title')).toBe(false)
    run(() => ed.commands.setBlockStyle('block-quote'))
    expect(ed.state.doc.firstChild!.firstChild!.firstChild!.attrs.styleId).toBe('block-quote')
  })
})

describe('Enter chaining', () => {
  it('Chapter Title -> First Paragraph -> Body', () => {
    const ed = mount([h(1, 'Chapter One', { styleId: 'chapter-title' })])
    caretAtEndOf(ed, 0)
    key(ed, 'Enter')
    run(() => ed.commands.insertContent('Opening'))
    key(ed, 'Enter')
    run(() => ed.commands.insertContent('Then'))
    key(ed, 'Enter')
    expect(blocks(ed).map((b) => b.dataset.style)).toEqual(['chapter-title', 'first-paragraph', 'body', 'body'])
    expect(ed.state.doc.child(1).type.name).toBe('paragraph')
    // One undo takes back the last Enter.
    run(() => ed.commands.undo())
    expect(ed.state.doc.childCount).toBeLessThan(4)
  })

  it('Chapter Number -> Chapter Title; a style without nextStyle continues itself', () => {
    const ed = mount([p('Quote', { styleId: 'block-quote' }), h(1, 'One', { styleId: 'chapter-number' })])
    caretAtEndOf(ed, 0)
    key(ed, 'Enter')
    expect(ed.state.doc.child(1).attrs.styleId).toBe('block-quote')
    caretAtEndOf(ed, 2)
    key(ed, 'Enter')
    expect(ed.state.doc.child(3).attrs).toMatchObject({ styleId: 'chapter-title', level: 1 })
  })

  it('does not carry the title\'s direct formatting into the next style', () => {
    const ed = mount([h(1, 'One', { styleId: 'chapter-title', textAlign: 'right' })])
    caretAtEndOf(ed, 0)
    key(ed, 'Enter')
    expect(ed.state.doc.child(1).attrs.textAlign).toBeNull()
  })
})

describe('direct formatting', () => {
  it('overrides the style inline, and Clear direct formatting restores the style', () => {
    const ed = mount([p('Hello', { styleId: 'block-quote' })])
    caretAtEndOf(ed, 0)
    run(() => ed.chain().setTextAlign('center').setBlockLineHeight('2').selectAll().toggleBold().run())
    const el = blocks(ed)[0]
    expect(el.style.textAlign).toBe('center')
    expect(el.querySelector('strong')).not.toBeNull()
    caretAtEndOf(ed, 0)
    key(ed, '\\', { ctrl: true })
    const after = ed.state.doc.child(0)
    expect(after.attrs).toMatchObject({ styleId: 'block-quote', textAlign: null, lineHeight: null })
    expect(blocks(ed)[0].getAttribute('style')).toBeNull()
    expect(blocks(ed)[0].querySelector('strong')).toBeNull()
  })
})

describe('Clear direct formatting', () => {
  it('is its own undo step (typing just before it survives the undo)', () => {
    const ed = mount([p('Hello', { textAlign: 'center' })])
    caretAtEndOf(ed, 0)
    run(() => ed.commands.insertContent(' there'))
    run(() => ed.commands.clearDirectFormatting())
    expect(ed.state.doc.child(0).attrs.textAlign).toBeNull()
    run(() => ed.commands.undo())
    expect(ed.state.doc.child(0).attrs.textAlign).toBe('center')
    expect(ed.state.doc.textContent).toBe('Hello there')
  })

  it('with a selection, removes marks only inside it; with a caret, from the whole block', () => {
    const bold = (text: string) => ({ type: 'text', text, marks: [{ type: 'bold' }] })
    const ed = mount([{ type: 'paragraph', content: [bold('one two three')] }])
    // Select "two" (positions: paragraph opens at 0, text starts at 1).
    run(() => ed.commands.setTextSelection({ from: 5, to: 8 }))
    run(() => ed.commands.clearDirectFormatting())
    const parts = () => {
      const out: Array<[string, boolean]> = []
      ed.state.doc.child(0).forEach((n) => void out.push([n.text!, n.marks.length > 0]))
      return out
    }
    expect(parts()).toEqual([['one ', true], ['two', false], [' three', true]])
    caretAtEndOf(ed, 0)
    run(() => ed.commands.clearDirectFormatting())
    expect(parts()).toEqual([['one two three', false]])
  })
})

describe('missing styles', () => {
  it('a style id brought back by redo after a delete renders with the Body fallback and shows as missing', () => {
    render(<Toolbar loadFonts={async () => []} />)
    const ed = mount([p('Dear Mara,')])
    let id = ''
    run(() => (id = createStyle('block-quote', 'Letter')))
    caretAtEndOf(ed, 0)
    run(() => ed.commands.setBlockStyle(id))
    run(() => ed.commands.undo())
    run(() => deleteStyle(id))
    run(() => ed.commands.redo())
    // The document keeps the dangling id; the block renders as Body.
    expect(ed.state.doc.child(0).attrs.styleId).toBe(id)
    expect(blocks(ed)[0].dataset.style).toBe('body')
    expect(readToolbarState(ed)).toMatchObject({ styleId: id, fallbackStyleId: 'body' })
    const picker = document.querySelector<HTMLSelectElement>('[data-control-id="styles.picker"]')!
    expect(picker.value).toBe(id)
    expect(picker.selectedOptions[0].textContent).toBe('Body (missing style)')
    const sheet = document.querySelector('[data-testid="book-styles"]')!.textContent!
    expect(sheet).not.toContain(`[data-style="${id}"]`)
    // Defining the id again (createStyle reuses the free id) renders the block with it again, with
    // no document change.
    const doc = ed.state.doc
    run(() => expect(createStyle('epigraph', 'Letter again')).toBe(id))
    expect(blocks(ed)[0].dataset.style).toBe(id)
    expect(ed.state.doc).toBe(doc)
  })

  it('dangling ids on headings render as Chapter Title (H1) / Subheading (H2, H3); defined styles render as themselves', () => {
    const ed = mount([h(1, 'A', { styleId: 'gone' }), h(3, 'B', { styleId: 'gone' }), p('C', { styleId: 'gone' }), p('D')])
    expect(blocks(ed).map((b) => b.dataset.style)).toEqual(['chapter-title', 'subheading', 'body', 'body'])
    expect(blocks(ed)[0].getAttribute('data-break-before')).toBe('page')
    // Typing in a block keeps its rendered style; an edit that renames nothing sends no full recompute.
    caretAtEndOf(ed, 2)
    run(() => ed.commands.insertContent('!'))
    expect(blocks(ed)[2].dataset.style).toBe('body')
    // A custom chapter style based on nothing renders as itself (and so gets nothing from Body).
    let id = ''
    run(() => (id = createStyle('body', 'Bare')))
    run(() =>
      saveStyle(id, { name: 'Bare', kind: 'chapter', outlineLevel: 1 }),
    )
    caretAtEndOf(ed, 3)
    run(() => ed.commands.setBlockStyle(id))
    expect(blocks(ed)[3].tagName).toBe('H1')
    expect(blocks(ed)[3].dataset.style).toBe(id)
    expect(document.querySelector('[data-testid="book-styles"]')!.textContent).toContain(`[data-style="${id}"] {  }`)
    // Structural edits (split, join across blocks, set type) keep exactly one correct decoration per
    // block, as a full recompute would give.
    const consistent = () => {
      const styles = getResolvedStyles()
      const decos = styleIdsKey.getState(ed.state)!.decorations.find()
      expect(decos).toHaveLength(ed.state.doc.childCount)
      ed.state.doc.forEach((node, offset, i) => {
        expect(blocks(ed)[i].dataset.style, `block ${i}`).toBe(renderedStyleId(node, styles))
        expect(decos.some((d) => d.from === offset && d.to === offset + node.nodeSize), `deco ${i}`).toBe(true)
      })
    }
    consistent()
    caretAtEndOf(ed, 0)
    key(ed, 'Enter')
    consistent()
    run(() => ed.commands.deleteRange({ from: 2, to: ed.state.doc.child(0).nodeSize + 3 }))
    consistent()
    caretAtEndOf(ed, 1)
    run(() => ed.commands.setBlockStyle('chapter-title'))
    run(() => ed.commands.undo())
    run(() => ed.commands.redo())
    consistent()
    // A many-step transaction (like Replace All) takes the full-recompute path.
    run(() => {
      const tr = ed.state.tr
      for (let i = 0; i < 40; i++) tr.insertText('x', 2)
      ed.view.dispatch(tr.split(3))
    })
    consistent()
  })

  it('locks the Kind of a custom style while paragraphs use it', () => {
    render(<Toolbar loadFonts={async () => []} />)
    const ed = mount([p('Dear Mara,')])
    let id = ''
    run(() => (id = createStyle('block-quote', 'Letter')))
    caretAtEndOf(ed, 0)
    run(() => ed.commands.setBlockStyle(id))
    act(() => void fireEvent.click(document.querySelector('[data-control-id="styles.edit"]')!))
    const kind = document.querySelector<HTMLSelectElement>('[data-control-id="styles.field.kind"]')!
    expect(kind.disabled).toBe(true)
    expect(document.querySelector('[data-testid="hint-kind"]')!.textContent).toBe('Fixed while 1 paragraph uses this style.')
  })
})

describe('style sheet and break exposure', () => {
  it('editing a definition rewrites the generated CSS with no editor transaction', () => {
    const ed = mount([h(1, 'One'), p('Text'), h(1, 'Two')])
    const sheet = document.querySelector('[data-testid="book-styles"]')!
    expect(sheet.textContent).toContain('[data-style="chapter-title"] { font-size: calc(20 * var(--nv-pt, 1pt));')
    let transactions = 0
    ed.on('transaction', () => transactions++)
    const doc = ed.state.doc
    run(() => saveStyle('chapter-title', { ...ownDef(getStyleDefinition('chapter-title')!), fontSize: 28 }))
    expect(sheet.textContent).toContain('[data-style="chapter-title"] { font-size: calc(28 * var(--nv-pt, 1pt));')
    expect(transactions).toBe(0)
    expect(ed.state.doc).toBe(doc)
    expect(useStore.getState().book.styles).toEqual({ 'chapter-title': { fontSize: 28 } })
  })

  it('emits data-break-before on breaking blocks, once per heading group, and follows style edits', () => {
    const ed = mount([
      h(1, 'One', { styleId: 'chapter-number' }),
      h(1, 'Title', { styleId: 'chapter-title' }),
      p('Text'),
      h(1, 'Two'),
    ])
    const attr = () => blocks(ed).map((b) => b.getAttribute('data-break-before'))
    expect(attr()).toEqual(['page', null, null, 'page'])
    const doc = ed.state.doc
    run(() => saveStyle('chapter-title', { ...ownDef(getStyleDefinition('chapter-title')!), breakBefore: 'recto' }))
    expect(attr()).toEqual(['page', null, null, 'recto'])
    expect(ed.state.doc).toBe(doc)
    // Undo history is not touched by a style edit.
    expect(ed.can().undo()).toBe(false)
    // Typing inside a block keeps the decorations.
    caretAtEndOf(ed, 3)
    run(() => ed.commands.insertContent('!'))
    expect(attr()).toEqual(['page', null, null, 'recto'])
  })
})

describe('custom styles', () => {
  it('create, duplicate, rename; delete re-maps blocks to the parent', () => {
    mount([p('A'), p('B')])
    let id = ''
    run(() => (id = createStyle('block-quote', 'Letter')))
    expect(getStyleDefinition(id)).toMatchObject({ name: 'Letter', basedOn: 'block-quote', kind: 'paragraph', builtIn: false })
    let copy: string | null = null
    run(() => (copy = duplicateStyle(id)))
    expect(getStyleDefinition(copy!)!.name).toBe('Letter copy')
    run(() => renameStyle(id, 'Letters'))
    expect(getStyleDefinition(id)!.name).toBe('Letters')
    expect(renameStyle('body', 'X')).toBe(false)

    const ed = getEditor()!
    caretAtEndOf(ed, 0)
    run(() => ed.commands.setBlockStyle(id))
    expect(blocks(ed)[0].dataset.style).toBe(id)
    let remapped: number | null = null
    run(() => (remapped = deleteStyle(id)))
    expect(remapped).toBe(1)
    expect(ed.state.doc.child(0).attrs.styleId).toBe('block-quote')
    expect(getStyleDefinition(id)).toBeUndefined()
    // The duplicate (also based on block-quote) is untouched; built-ins cannot be deleted.
    expect(getStyleDefinition(copy!)).toBeDefined()
    expect(deleteStyle('body')).toBeNull()
  })
})
