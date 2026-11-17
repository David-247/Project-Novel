import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { useStore } from '@/shared/store'
import { setTrackChangesAuthorSource } from '@/features/track-changes'
import { paragraphSpacingCommands } from './commands'
import { getEditor, NovelEditor, setDocJSON } from './index'
import type { Editor } from './index'
import { installLayoutPolyfills } from './jsdom-polyfills.test-util'

/**
 * Format > Line Spacing / Space After / First-Line Indent (T6): the paragraph presets as registry
 * commands, so the ribbon's collapsed Paragraph group and the menu bar offer what the toolbar fields do.
 */

beforeAll(installLayoutPolyfills)
beforeEach(() => setTrackChangesAuthorSource(() => ({ name: 'Ann', color: null })))
afterEach(() => {
  cleanup()
  setDocJSON({ type: 'doc', content: [{ type: 'paragraph' }] })
  useStore.getState().bookActions.resetBook()
  setTrackChangesAuthorSource(null)
})

const ATTR = { lineSpacing: 'lineHeight', spaceAfter: 'paragraphSpacing', firstLineIndent: 'firstLineIndent' } as const
type Kind = keyof typeof ATTR

function setup(): Editor {
  render(<NovelEditor />)
  act(() =>
    setDocJSON({
      type: 'doc',
      content: ['one', 'two'].map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
    }),
  )
  const ed = getEditor()
  if (!ed) throw new Error('editor not mounted')
  act(() => void ed.commands.setTextSelection(2))
  return ed
}

const commands = () => new Map(paragraphSpacingCommands().map((c) => [c.id, c]))
const runCmd = (id: string) => {
  const c = commands().get(id)
  if (!c) throw new Error(`no command ${id}`)
  act(() => c.run())
}
const first = (ed: Editor) => ed.state.doc.firstChild!

describe('paragraph spacing commands', () => {
  it('have stable ids, one per preset, in the Format menu submenus', () => {
    const cmds = paragraphSpacingCommands()
    expect(cmds.map((c) => c.id)).toEqual([
      'format.lineSpacing.default',
      'format.lineSpacing.1',
      'format.lineSpacing.1.15',
      'format.lineSpacing.1.5',
      'format.lineSpacing.2',
      'format.spaceAfter.default',
      'format.spaceAfter.0',
      'format.spaceAfter.0.5em',
      'format.spaceAfter.1em',
      'format.spaceAfter.1.5em',
      'format.firstLineIndent.default',
      'format.firstLineIndent.0',
      'format.firstLineIndent.1em',
      'format.firstLineIndent.1.5em',
      'format.firstLineIndent.2em',
      'format.firstLineIndent.0.5in',
    ])
    expect(new Set(cmds.map((c) => c.menu?.submenu))).toEqual(new Set(['Line Spacing', 'Space After', 'First-Line Indent']))
    for (const c of cmds) {
      expect(c.description).toMatch(/\.$/)
      expect(c.label).not.toMatch(/:/)
    }
  })

  it.each([
    ['lineSpacing', '1.5'],
    ['spaceAfter', '1em'],
    ['firstLineIndent', '0.5in'],
  ] as const)('%s: sets %s on the paragraph, Default sets it back to null', (kind: Kind, value) => {
    const ed = setup()
    runCmd(`format.${kind}.${value}`)
    expect(first(ed).attrs[ATTR[kind]]).toBe(value)
    expect(ed.state.doc.child(1).attrs[ATTR[kind]]).toBeNull() // only the paragraph at the selection
    runCmd(`format.${kind}.default`)
    expect(first(ed).attrs[ATTR[kind]]).toBeNull()
  })

  it('checked state follows the paragraph at the selection; exactly one preset per list is checked', () => {
    const ed = setup()
    const checked = (prefix: string) =>
      paragraphSpacingCommands()
        .filter((c) => c.id.startsWith(prefix) && c.isChecked!())
        .map((c) => c.id)
    expect(checked('format.lineSpacing.')).toEqual(['format.lineSpacing.default'])
    runCmd('format.lineSpacing.2')
    expect(checked('format.lineSpacing.')).toEqual(['format.lineSpacing.2'])
    act(() => void ed.commands.setTextSelection(6)) // second paragraph: nothing set
    expect(checked('format.lineSpacing.')).toEqual(['format.lineSpacing.default'])
    act(() => void ed.commands.setTextSelection(2))
    expect(checked('format.lineSpacing.')).toEqual(['format.lineSpacing.2'])
    expect(checked('format.spaceAfter.')).toEqual(['format.spaceAfter.default'])
    expect(checked('format.firstLineIndent.')).toEqual(['format.firstLineIndent.default'])
  })

  it.each([
    ['lineSpacing', '1.15'],
    ['spaceAfter', '0'],
    ['firstLineIndent', '2em'],
  ] as const)('%s %s is one undo step', (kind: Kind, value) => {
    const ed = setup()
    runCmd(`format.${kind}.${value}`)
    expect(first(ed).attrs[ATTR[kind]]).toBe(value)
    act(() => void ed.commands.undo())
    expect(first(ed).attrs[ATTR[kind]]).toBeNull()
    expect(ed.state.doc.textContent).toBe('onetwo')
  })

  it.each([
    ['lineSpacing', '1.5', (ed: Editor, v: string) => ed.chain().setBlockLineHeight(v).run()],
    ['spaceAfter', '1em', (ed: Editor, v: string) => ed.chain().setBlockSpacing(v).run()],
    ['firstLineIndent', '0.5in', (ed: Editor, v: string) => ed.chain().setFirstLineIndent(v).run()],
  ] as const)('with Track Changes on, %s is recorded as a formatting change, like the toolbar field', (kind: Kind, value, field) => {
    act(() => useStore.getState().bookActions.setTrackChanges(true))
    const ed = setup()
    runCmd(`format.${kind}.${value}`)
    const viaCommand = first(ed).attrs
    expect(viaCommand[ATTR[kind]]).toBe(value)
    expect(viaCommand.trackedStyleChange).toMatchObject({ author: 'Ann' })
    // One undo step takes back the change and its record.
    act(() => void ed.commands.undo())
    expect(first(ed).attrs[ATTR[kind]]).toBeNull()
    expect(first(ed).attrs.trackedStyleChange).toBeNull()
    // The toolbar field's command records the same thing.
    act(() => void field(ed, value))
    expect(first(ed).attrs.trackedStyleChange).toMatchObject({ author: 'Ann' })
    expect(first(ed).attrs[ATTR[kind]]).toBe(value)
  })
})
