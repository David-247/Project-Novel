import { describe, expect, it } from 'vitest'
import { Schema } from '@tiptap/pm/model'
import { EditorState } from '@tiptap/pm/state'
import { EditorView } from '@tiptap/pm/view'

/**
 * Guard: the pagination engine relies on a few prosemirror-view internals (each with a fallback,
 * but the fallbacks are slower or less exact). prosemirror-view is pinned in package.json
 * (pnpm.overrides); if an upgrade removes any of these, this test fails loudly so engine.ts,
 * PaginatedView.tsx and the docs are revisited before shipping:
 *  - `dom.pmViewDesc.node` on top-level block elements (O(n) block walk in a pass),
 *  - `view.domObserver.flush()` / `forceFlush()` (read pending DOM selection before redrawing),
 *  - `view.input.mouseDown` (no redraw during a pointer drag),
 *  - `view.input.lastClick.time` (click bookkeeping for presses the slice handles itself).
 */
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'text*', toDOM: () => ['p', 0] },
    text: {},
  },
})

describe('prosemirror-view internals used by the pagination engine', () => {
  it('are all still there', () => {
    const doc = schema.node('doc', null, [schema.node('paragraph', null, [schema.text('one')]), schema.node('paragraph', null, [schema.text('two')])])
    const view = new EditorView(document.createElement('div'), { state: EditorState.create({ doc }) })
    try {
      const first = view.dom.firstElementChild as (Element & { pmViewDesc?: { node?: unknown } }) | null
      expect(first?.pmViewDesc?.node, 'dom.pmViewDesc.node').toBe(doc.firstChild)
      const second = first?.nextElementSibling as (Element & { pmViewDesc?: { node?: unknown } }) | null
      expect(second?.pmViewDesc?.node).toBe(doc.child(1))

      const internals = view as unknown as {
        domObserver?: { flush?: unknown; forceFlush?: unknown }
        input?: Record<string, unknown> & { lastClick?: { time?: unknown } }
      }
      expect(typeof internals.domObserver?.flush, 'domObserver.flush').toBe('function')
      expect(typeof internals.domObserver?.forceFlush, 'domObserver.forceFlush').toBe('function')
      expect(internals.input && 'mouseDown' in internals.input, 'input.mouseDown').toBe(true)
      expect(typeof internals.input?.lastClick?.time, 'input.lastClick.time').toBe('number')
    } finally {
      view.destroy()
    }
  })
})
