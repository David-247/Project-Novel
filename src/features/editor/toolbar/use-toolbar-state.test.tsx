import { Editor, type JSONContent } from '@tiptap/core'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createEditorExtensions } from '../extensions'
import { installLayoutPolyfills } from '../jsdom-polyfills.test-util'
import { useToolbarState } from './use-toolbar-state'

/**
 * The shared toolbar state (T6): every ribbon group reads it, but it is computed once per transaction
 * and editor, readers re-render only on a change, and it follows detach / re-attach and editor swaps.
 */

const reads = vi.hoisted(() => ({ count: 0 }))
vi.mock('./toolbar-state', async (importOriginal) => {
  const real = await importOriginal<typeof import('./toolbar-state')>()
  return {
    ...real,
    readToolbarState: (...args: Parameters<typeof real.readToolbarState>) => {
      reads.count++
      return real.readToolbarState(...args)
    },
  }
})

beforeAll(installLayoutPolyfills)
const editors: Editor[] = []
afterEach(() => {
  cleanup()
  editors.splice(0).forEach((e) => e.destroy())
})

function make(text: string): Editor {
  const content: JSONContent[] = [{ type: 'paragraph', content: [{ type: 'text', text }] }]
  const ed = new Editor({ element: document.createElement('div'), extensions: createEditorExtensions(), content: { type: 'doc', content } })
  editors.push(ed)
  ed.commands.setTextSelection({ from: 1, to: 1 + text.length })
  return ed
}

const renders: Record<string, number> = {}
const rendered = (name: string) => void (renders[name] = (renders[name] ?? 0) + 1)
function Reader({ editor, name }: { editor: Editor | null; name: string }) {
  const s = useToolbarState(editor)
  rendered(name)
  return <span data-testid={name}>{`${s.bold ? 'B' : '-'}${s.italic ? 'I' : '-'}${s.align}`}</span>
}
const shown = (name: string) => screen.getByTestId(name).textContent

describe('useToolbarState (shared per editor)', () => {
  it('several readers share one reading per transaction and all follow the active states', () => {
    const ed = make('hello')
    render(
      <>
        <Reader editor={ed} name="a" />
        <Reader editor={ed} name="b" />
        <Reader editor={ed} name="c" />
      </>,
    )
    expect(shown('a')).toBe('--left')
    reads.count = 0
    act(() => void ed.commands.toggleBold())
    expect(reads.count).toBe(1)
    expect([shown('a'), shown('b'), shown('c')]).toEqual(['B-left', 'B-left', 'B-left'])
    act(() => void ed.commands.setTextAlign('center'))
    expect(shown('b')).toBe('B-center')
  })

  it('readers do not re-render when a transaction changes nothing they show', () => {
    const ed = make('hello')
    render(<Reader editor={ed} name="quiet" />)
    const before = renders.quiet
    act(() => void ed.view.dispatch(ed.state.tr.setMeta('nothing', true)))
    expect(renders.quiet).toBe(before)
  })

  it('detaches with the last reader and reads fresh state when a reader attaches again', () => {
    const ed = make('hello')
    const first = render(<Reader editor={ed} name="r1" />)
    expect(shown('r1')).toBe('--left')
    first.unmount()
    // No reader: changes are not watched...
    act(() => void ed.commands.toggleItalic())
    // ...and a new reader still sees them.
    render(<Reader editor={ed} name="r2" />)
    expect(shown('r2')).toBe('-Ileft')
    act(() => void ed.commands.toggleItalic())
    expect(shown('r2')).toBe('--left')
  })

  it('follows an editor swap (another project opened): the old editor no longer drives the reader', () => {
    const one = make('one')
    const two = make('two')
    act(() => void two.commands.toggleBold())
    const view = render(<Reader editor={one} name="swap" />)
    expect(shown('swap')).toBe('--left')
    view.rerender(<Reader editor={two} name="swap" />)
    expect(shown('swap')).toBe('B-left')
    const before = renders.swap
    act(() => void one.commands.toggleItalic())
    expect(renders.swap).toBe(before)
    expect(shown('swap')).toBe('B-left')
    act(() => void two.commands.setTextAlign('right'))
    expect(shown('swap')).toBe('B-right')
  })

  it('a null editor reads the idle state', () => {
    render(<Reader editor={null} name="idle" />)
    expect(shown('idle')).toBe('--left')
  })
})
