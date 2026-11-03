import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Profiler } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { IconButton } from '@/shared/ui'
import { getEditor, NovelEditor, setDocJSON, Toolbar, TOOLBAR_CONTROLS, ToolbarItem } from '../index'
import type { Editor } from '../index'
import { installLayoutPolyfills } from '../jsdom-polyfills.test-util'
import { readToolbarState } from './toolbar-state'

beforeAll(installLayoutPolyfills)
afterEach(() => {
  cleanup()
  setDocJSON({ type: 'doc', content: [{ type: 'paragraph' }] })
})

const noFonts = async () => [] as string[]

function setup(extra?: { leadingGroups?: React.ReactNode; extraGroups?: React.ReactNode }) {
  render(
    <>
      <Toolbar loadFonts={noFonts} {...extra} />
      <NovelEditor />
    </>,
  )
  const ed = getEditor()
  if (!ed) throw new Error('editor not mounted')
  return ed
}

const ctl = (id: string) => {
  const el = document.querySelector<HTMLElement>(`[data-control-id="${id}"]`)
  if (!el) throw new Error(`no control ${id}`)
  return el
}

/** Keyboard click: detail 0, so focus stays in the toolbar. */
const press = (id: string) => act(() => void fireEvent.click(ctl(id), { detail: 0 }))
const choose = (id: string, value: string) => act(() => void fireEvent.change(ctl(id), { target: { value } }))
const run = (fn: () => unknown) => act(() => void fn())

function key(ed: Editor, k: string, opts: { shift?: boolean } = {}) {
  act(() => {
    ed.view.dom.dispatchEvent(
      new KeyboardEvent('keydown', { key: k, ctrlKey: true, shiftKey: !!opts.shift, bubbles: true, cancelable: true }),
    )
  })
}

const firstBlock = (ed: Editor) => ed.state.doc.firstChild!

describe('Toolbar structure', () => {
  it('is an ARIA toolbar where every control has a stable data-control-id and accessible name', () => {
    setup()
    const bar = screen.getByRole('toolbar', { name: 'Formatting' })
    for (const meta of Object.values(TOOLBAR_CONTROLS)) {
      const el = within(bar).getByLabelText(meta.label)
      expect(el).toHaveAttribute('data-control-id', meta.id)
    }
    const ids = Object.values(TOOLBAR_CONTROLS).map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.every((id) => id.startsWith('toolbar.'))).toBe(true)
  })

  it('uses roving focus: one tab stop, arrow keys move between controls', async () => {
    setup()
    const bar = screen.getByRole('toolbar', { name: 'Formatting' })
    const items = () => Array.from(bar.querySelectorAll<HTMLElement>('[data-control-id]'))
    // Before first visit the toolbar itself is the single tab stop (it forwards focus to the first item).
    expect(items().every((el) => el.tabIndex === -1)).toBe(true)
    const bold = ctl('toolbar.bold')
    act(() => bold.focus())
    await waitFor(() => expect(items().filter((el) => el.tabIndex === 0)).toEqual([bold]))
    act(() => void fireEvent.keyDown(bold, { key: 'ArrowRight' }))
    await waitFor(() => expect(document.activeElement).toBe(ctl('toolbar.italic')))
    act(() => void fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' }))
    await waitFor(() => expect(document.activeElement).toBe(bold))
    act(() => void fireEvent.keyDown(bold, { key: 'End' }))
    await waitFor(() => expect(document.activeElement).toBe(ctl('toolbar.indentIncrease')))
    act(() => void fireEvent.keyDown(document.activeElement!, { key: 'Home' }))
    await waitFor(() => expect(document.activeElement).toBe(ctl('toolbar.fontFamily')))
    // Tabbing back into the toolbar lands on the last-focused control.
    act(() => (document.activeElement as HTMLElement).blur())
    act(() => bar.focus())
    await waitFor(() => expect(document.activeElement).toBe(ctl('toolbar.fontFamily')))
  })

  it('is enabled right after mount and reflects a loaded document without a transaction', () => {
    setup()
    expect(ctl('toolbar.bold')).toBeEnabled()
    run(() =>
      setDocJSON({
        type: 'doc',
        content: [{ type: 'paragraph', attrs: { textAlign: 'center', lineHeight: '2' }, content: [{ type: 'text', text: 'x' }] }],
      }),
    )
    expect(ctl('toolbar.alignCenter')).toHaveAttribute('aria-pressed', 'true')
    expect(ctl('toolbar.lineSpacing')).toHaveValue('2')
  })

  it('Escape returns focus to the manuscript', async () => {
    const ed = setup()
    act(() => ctl('toolbar.bold').focus())
    act(() => void fireEvent.keyDown(ctl('toolbar.bold'), { key: 'Escape' }))
    await waitFor(() => expect(document.activeElement).toBe(ed.view.dom))
  })

  it('leaves Escape alone for slot content that is not a toolbar item, or already handled', () => {
    const ed = setup({
      extraGroups: <input aria-label="Find text" data-testid="find" />,
    })
    const find = screen.getByTestId('find')
    act(() => find.focus())
    act(() => void fireEvent.keyDown(find, { key: 'Escape' }))
    expect(document.activeElement).toBe(find)
    const bold = ctl('toolbar.bold')
    bold.addEventListener('keydown', (e) => e.preventDefault())
    act(() => bold.focus())
    act(() => void fireEvent.keyDown(bold, { key: 'Escape' }))
    expect(document.activeElement).not.toBe(ed.view.dom)
  })

  it('renders leading/extra group slots inside the roving focus group', async () => {
    setup({
      leadingGroups: (
        <ToolbarItem>
          <IconButton label="Undo" data-control-id="history.undo">
            u
          </IconButton>
        </ToolbarItem>
      ),
      extraGroups: (
        <ToolbarItem>
          <IconButton label="Find" data-control-id="find.open">
            f
          </IconButton>
        </ToolbarItem>
      ),
    })
    const bar = screen.getByRole('toolbar', { name: 'Formatting' })
    const ids = Array.from(bar.querySelectorAll('[data-control-id]')).map((e) => e.getAttribute('data-control-id'))
    expect(ids[0]).toBe('history.undo')
    expect(ids.at(-1)).toBe('find.open')
    const last = ctl('toolbar.indentIncrease')
    act(() => last.focus())
    act(() => void fireEvent.keyDown(last, { key: 'ArrowRight' }))
    await waitFor(() => expect(document.activeElement).toBe(ctl('find.open')))
  })
})

describe('Toolbar marks', () => {
  it('toggles bold/italic/underline and reflects active state on selection change', () => {
    const ed = setup()
    run(() => ed.chain().insertContent('plain bold').setTextSelection({ from: 7, to: 11 }).run())
    press('toolbar.bold')
    press('toolbar.italic')
    press('toolbar.underline')
    expect(ed.isActive('bold') && ed.isActive('italic') && ed.isActive('underline')).toBe(true)
    for (const id of ['toolbar.bold', 'toolbar.italic', 'toolbar.underline']) {
      expect(ctl(id)).toHaveAttribute('aria-pressed', 'true')
    }

    run(() => ed.commands.setTextSelection(3)) // inside "plain"
    expect(ctl('toolbar.bold')).toHaveAttribute('aria-pressed', 'false')
    run(() => ed.commands.setTextSelection(9)) // inside "bold"
    expect(ctl('toolbar.bold')).toHaveAttribute('aria-pressed', 'true')

    run(() => ed.commands.setTextSelection({ from: 7, to: 11 }))
    press('toolbar.bold')
    expect(ed.isActive('bold')).toBe(false)
    expect(ctl('toolbar.bold')).toHaveAttribute('aria-pressed', 'false')
  })

  it('pointer activation returns focus to the editor; keyboard activation keeps it in the toolbar', async () => {
    const ed = setup()
    run(() => ed.chain().insertContent('x').selectAll().run())
    const bold = ctl('toolbar.bold')
    act(() => bold.focus())
    press('toolbar.bold')
    expect(document.activeElement).toBe(bold)
    act(() => void fireEvent.click(bold, { detail: 1 }))
    await waitFor(() => expect(document.activeElement).toBe(ed.view.dom))
  })

  it('font size picked at a bare caret applies to the text typed next', async () => {
    const ed = setup()
    run(() => ed.commands.insertContent('Plain '))
    choose('toolbar.fontSize', '18pt')
    // Focus returns to the text (selection unchanged), so the stored mark survives.
    await waitFor(() => expect(document.activeElement).toBe(ed.view.dom))
    expect(ctl('toolbar.fontSize')).toHaveValue('18pt')
    run(() => ed.view.dispatch(ed.state.tr.insertText('big')))
    const runs = ed.getJSON().content![0].content!
    expect(runs.at(-1)).toEqual({
      type: 'text',
      text: 'big',
      marks: [{ type: 'textStyle', attrs: { fontFamily: null, fontSize: '18pt' } }],
    })
    expect(runs[0].marks).toBeUndefined()
  })

  it('font family picked at a bare caret applies to the text typed next', async () => {
    render(
      <>
        <Toolbar loadFonts={async () => ['Georgia']} />
        <NovelEditor />
      </>,
    )
    const ed = getEditor()!
    await screen.findByRole('option', { name: 'Georgia' })
    run(() => ed.commands.insertContent('Plain '))
    choose('toolbar.fontFamily', 'Georgia')
    await waitFor(() => expect(document.activeElement).toBe(ed.view.dom))
    run(() => ed.view.dispatch(ed.state.tr.insertText('serif')))
    expect(ed.getJSON().content![0].content!.at(-1)!.marks![0].attrs!.fontFamily).toContain('Georgia')
  })

  it('a range shows a mark as active only when both ends carry it', () => {
    const ed = setup()
    run(() => ed.chain().insertContent('aaa bbb ccc').setTextSelection({ from: 1, to: 4 }).toggleBold().run())
    run(() => ed.commands.setTextSelection({ from: 1, to: 12 }))
    expect(ctl('toolbar.bold')).toHaveAttribute('aria-pressed', 'false')
    run(() => ed.commands.setTextSelection({ from: 2, to: 4 }))
    expect(ctl('toolbar.bold')).toHaveAttribute('aria-pressed', 'true')
  })

  it('applies and clears font size as a TextStyle attribute', () => {
    const ed = setup()
    run(() => ed.chain().insertContent('Some prose').selectAll().run())
    choose('toolbar.fontSize', '24pt')
    const mark = ed.getJSON().content![0].content![0].marks![0]
    expect(mark).toEqual({ type: 'textStyle', attrs: { fontFamily: null, fontSize: '24pt' } })
    expect(ctl('toolbar.fontSize')).toHaveValue('24pt')
    expect(ed.view.dom.innerHTML).toContain('font-size: 24pt')
    choose('toolbar.fontSize', '')
    expect(ed.getJSON().content![0].content![0].marks).toBeUndefined()
    expect(ctl('toolbar.fontSize')).toHaveValue('')
  })
})

describe('Toolbar blocks', () => {
  it('toggles bulleted and numbered lists', () => {
    const ed = setup()
    run(() => ed.commands.insertContent('item'))
    press('toolbar.bulletList')
    expect(ed.state.doc.firstChild!.type.name).toBe('bulletList')
    expect(ctl('toolbar.bulletList')).toHaveAttribute('aria-pressed', 'true')
    press('toolbar.orderedList')
    expect(ed.state.doc.firstChild!.type.name).toBe('orderedList')
    expect(ctl('toolbar.bulletList')).toHaveAttribute('aria-pressed', 'false')
    expect(ctl('toolbar.orderedList')).toHaveAttribute('aria-pressed', 'true')
    press('toolbar.orderedList')
    expect(ed.state.doc.firstChild!.type.name).toBe('paragraph')
  })

  it('sets alignment on paragraphs and headings with exactly one pressed alignment', () => {
    const ed = setup()
    run(() => ed.commands.insertContent('centered'))
    const pressed = () =>
      ['alignLeft', 'alignCenter', 'alignRight', 'alignJustify'].filter(
        (k) => ctl(`toolbar.${k}`).getAttribute('aria-pressed') === 'true',
      )
    expect(pressed()).toEqual(['alignLeft'])
    press('toolbar.alignCenter')
    expect(firstBlock(ed).attrs.textAlign).toBe('center')
    expect(pressed()).toEqual(['alignCenter'])
    expect(ed.view.dom.innerHTML).toContain('text-align: center')
    press('toolbar.alignJustify')
    expect(pressed()).toEqual(['alignJustify'])
    press('toolbar.alignLeft')
    expect(firstBlock(ed).attrs.textAlign).toBeNull()
    expect(pressed()).toEqual(['alignLeft'])

    run(() => ed.commands.setHeading({ level: 2 }))
    press('toolbar.alignRight')
    expect(firstBlock(ed).type.name).toBe('heading')
    expect(firstBlock(ed).attrs.textAlign).toBe('right')
  })

  it('sets line spacing and space-after presets as node attributes rendered inline', () => {
    const ed = setup()
    run(() => ed.commands.insertContent('one'))
    choose('toolbar.lineSpacing', '1.5')
    choose('toolbar.paragraphSpacing', '1em')
    expect(firstBlock(ed).attrs).toMatchObject({ lineHeight: '1.5', paragraphSpacing: '1em' })
    const p = ed.view.dom.querySelector('p')!
    expect(p.style.lineHeight).toBe('1.5')
    expect(p.style.marginBottom).toBe('1em')
    expect(ctl('toolbar.lineSpacing')).toHaveValue('1.5')
    expect(ctl('toolbar.paragraphSpacing')).toHaveValue('1em')
    choose('toolbar.lineSpacing', '')
    expect(firstBlock(ed).attrs.lineHeight).toBeNull()
  })

  it('sets a first-line indent preset rendered as text-indent, and reflects it per block', () => {
    const ed = setup()
    run(() =>
      setDocJSON({
        type: 'doc',
        content: ['a', 'b'].map((t) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] })),
      }),
    )
    run(() => ed.commands.setTextSelection(1))
    expect(ctl('toolbar.firstLineIndent')).toHaveValue('')
    choose('toolbar.firstLineIndent', '0.5in')
    expect(firstBlock(ed).attrs.firstLineIndent).toBe('0.5in')
    expect(ed.view.dom.querySelector('p')!.style.textIndent).toBe('0.5in')
    expect(ctl('toolbar.firstLineIndent')).toHaveValue('0.5in')
    run(() => ed.commands.setTextSelection(4)) // second paragraph: unset
    expect(ctl('toolbar.firstLineIndent')).toHaveValue('')
    run(() => ed.commands.setTextSelection(1))
    expect(ctl('toolbar.firstLineIndent')).toHaveValue('0.5in')
    choose('toolbar.firstLineIndent', '0')
    expect(firstBlock(ed).attrs.firstLineIndent).toBe('0')
    choose('toolbar.firstLineIndent', '')
    expect(firstBlock(ed).attrs.firstLineIndent).toBeNull()
    // Unsafe values are rejected rather than written into a style attribute.
    run(() => ed.commands.setFirstLineIndent('1em; color: red'))
    expect(firstBlock(ed).attrs.firstLineIndent).toBeNull()
  })

  it('applies block attributes to every block in the selection only', () => {
    const ed = setup()
    run(() =>
      setDocJSON({
        type: 'doc',
        content: ['a', 'b', 'c'].map((t) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] })),
      }),
    )
    run(() => ed.commands.setTextSelection({ from: 1, to: 4 })) // a..b
    choose('toolbar.lineSpacing', '2')
    const lh = [] as unknown[]
    ed.state.doc.forEach((n) => lh.push(n.attrs.lineHeight))
    expect(lh).toEqual(['2', '2', null])
  })

  it('indents and outdents blocks, disabling at the limits', () => {
    const ed = setup()
    run(() => ed.commands.insertContent('indent me'))
    expect(ctl('toolbar.indentDecrease')).toBeDisabled()
    press('toolbar.indentIncrease')
    press('toolbar.indentIncrease')
    expect(firstBlock(ed).attrs.indent).toBe(2)
    expect(ed.view.dom.querySelector('p')!.style.marginLeft).toBe('4em')
    expect(ctl('toolbar.indentDecrease')).toBeEnabled()
    for (let i = 0; i < 10; i++) run(() => ed.commands.indentBlock())
    expect(firstBlock(ed).attrs.indent).toBe(8)
    expect(ctl('toolbar.indentIncrease')).toBeDisabled()
    run(() => ed.commands.outdentBlock())
    expect(firstBlock(ed).attrs.indent).toBe(7)
  })

  it('increase indent is disabled on a first list item that cannot nest', () => {
    const ed = setup()
    run(() => ed.chain().insertContent('one').toggleBulletList().run())
    expect(ctl('toolbar.indentIncrease')).toBeDisabled()
    run(() => ed.chain().splitListItem('listItem').insertContent('two').run())
    expect(ctl('toolbar.indentIncrease')).toBeEnabled()
  })

  it('indent inside a list nests the list item', () => {
    const ed = setup()
    run(() => ed.chain().insertContent('one').toggleBulletList().run())
    run(() => ed.chain().splitListItem('listItem').insertContent('two').run())
    press('toolbar.indentIncrease')
    const list = ed.state.doc.firstChild!
    expect(list.childCount).toBe(1)
    expect(list.firstChild!.lastChild!.type.name).toBe('bulletList')
    press('toolbar.indentDecrease')
    expect(ed.state.doc.firstChild!.childCount).toBe(2)
  })

  it('parses block attributes from HTML', () => {
    const ed = setup()
    run(() =>
      ed.commands.setContent(
        '<p style="line-height: 2; margin-bottom: 0.5em; text-align: right; text-indent: 1.5em" data-indent="3">x</p>',
      ),
    )
    expect(firstBlock(ed).attrs).toMatchObject({ lineHeight: '2', paragraphSpacing: '0.5em', textAlign: 'right', indent: 3, firstLineIndent: '1.5em' })
  })
})

describe('Keyboard shortcuts', () => {
  it('Mod-b / Mod-i / Mod-u toggle marks', () => {
    const ed = setup()
    run(() => ed.chain().insertContent('word').selectAll().run())
    key(ed, 'b')
    key(ed, 'i')
    key(ed, 'u')
    expect(ed.isActive('bold') && ed.isActive('italic') && ed.isActive('underline')).toBe(true)
    expect(ctl('toolbar.bold')).toHaveAttribute('aria-pressed', 'true')
    key(ed, 'b')
    expect(ed.isActive('bold')).toBe(false)
  })

  it('Mod-Shift-8 / Mod-Shift-7 toggle lists', () => {
    const ed = setup()
    run(() => ed.commands.insertContent('item'))
    key(ed, '8', { shift: true })
    expect(firstBlock(ed).type.name).toBe('bulletList')
    key(ed, '7', { shift: true })
    expect(firstBlock(ed).type.name).toBe('orderedList')
  })

  it('Mod-Shift-l/e/r/j set alignment', () => {
    const ed = setup()
    run(() => ed.commands.insertContent('aligned'))
    for (const [k, v] of [
      ['e', 'center'],
      ['r', 'right'],
      ['j', 'justify'],
      ['l', 'left'],
    ] as const) {
      key(ed, k, { shift: true })
      expect(firstBlock(ed).attrs.textAlign).toBe(v)
    }
    expect(ctl('toolbar.alignLeft')).toHaveAttribute('aria-pressed', 'true')
  })

  it('Mod-] / Mod-[ indent and outdent', () => {
    const ed = setup()
    run(() => ed.commands.insertContent('x'))
    key(ed, ']')
    expect(firstBlock(ed).attrs.indent).toBe(1)
    key(ed, '[')
    expect(firstBlock(ed).attrs.indent).toBe(0)
  })
})

describe('Toolbar state cost', () => {
  it('reads state in O(depth): no document or range scan, caret near the end of a big doc', () => {
    const ed = setup()
    const para = (i: number) => ({ type: 'paragraph', content: [{ type: 'text', text: `paragraph ${i} `.repeat(20) }] })
    run(() => setDocJSON({ type: 'doc', content: Array.from({ length: 5000 }, (_, i) => para(i)) }))
    const end = ed.state.doc.content.size - 3
    const spy = vi.spyOn(ed.state.doc, 'nodesBetween') // selection changes keep the same doc
    for (const sel of [end, { from: 1, to: end }]) {
      run(() => ed.commands.setTextSelection(sel))
      readToolbarState(ed)
      const t0 = performance.now()
      for (let i = 0; i < 500; i++) readToolbarState(ed)
      const per = (performance.now() - t0) / 500
      expect(spy).not.toHaveBeenCalled()
      expect(per).toBeLessThan(0.2)
    }
  })

  it('does not re-render the toolbar on a keystroke that leaves its state unchanged', () => {
    let renders = 0
    render(
      <>
        <Profiler id="tb" onRender={() => void renders++}>
          <Toolbar loadFonts={noFonts} />
        </Profiler>
        <NovelEditor />
      </>,
    )
    const ed = getEditor()!
    run(() => ed.commands.insertContent('abc'))
    const before = renders
    run(() => ed.commands.insertContent('d'))
    run(() => ed.commands.insertContent('e'))
    expect(renders).toBe(before)
    run(() => ed.chain().selectAll().toggleBold().run())
    expect(renders).toBeGreaterThan(before)
  })
})

describe('Legacy and hostile documents', () => {
  it('loads a legacy doc without block attributes, with defaults and no inline style', () => {
    const ed = setup()
    run(() =>
      setDocJSON({
        type: 'doc',
        content: [
          { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Old' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'doc' }] },
        ],
      }),
    )
    ed.state.doc.forEach((n) =>
      expect(n.attrs).toMatchObject({ textAlign: null, lineHeight: null, paragraphSpacing: null, indent: 0, firstLineIndent: null }),
    )
    for (const el of ed.view.dom.querySelectorAll('h2, p')) expect(el.getAttribute('style')).toBeNull()
    expect(ctl('toolbar.alignLeft')).toHaveAttribute('aria-pressed', 'true')
  })

  it('renders no style for hostile or malformed attribute values', () => {
    const ed = setup()
    const evil = 'red; background: url(https://example.invalid/x)'
    run(() =>
      setDocJSON({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            attrs: { lineHeight: evil, paragraphSpacing: '1em;color:red', firstLineIndent: 'expression(alert(1))', indent: 'x' },
            content: [{ type: 'text', text: 'x', marks: [{ type: 'textStyle', attrs: { fontSize: '1px; color: red' } }] }],
          },
        ],
      }),
    )
    const p = ed.view.dom.querySelector('p')!
    expect(p.getAttribute('style')).toBeNull()
    expect(p.hasAttribute('data-indent')).toBe(false)
    expect(ed.view.dom.innerHTML).not.toContain('url(')
    expect(ed.view.dom.innerHTML).not.toContain('color')
  })
})
