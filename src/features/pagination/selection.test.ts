import { describe, expect, it } from 'vitest'
import { getSchema } from '@tiptap/core'
import { Selection } from '@tiptap/pm/state'
import { createEditorExtensions } from '@/features/editor'
import { extendTo } from './PaginatedView'

const schema = getSchema(createEditorExtensions())

describe('extendTo (Shift + document start / end, page keys)', () => {
  it('stays in inline content when the document starts and ends with a break atom', () => {
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.pageBreak.create(),
      schema.nodes.paragraph.create(null, schema.text('Middle text.')),
      schema.nodes.sceneBreak.create(),
    ])
    const inText = 5
    for (const [edge, dir] of [
      [Selection.atStart(doc), -1],
      [Selection.atEnd(doc), 1],
      [{ head: 0 }, -1],
      [{ head: doc.content.size }, 1],
    ] as const) {
      const sel = extendTo(doc, inText, edge.head, dir)
      expect(sel.$anchor.parent.inlineContent).toBe(true)
      expect(sel.$head.parent.inlineContent).toBe(true)
      expect(sel.anchor).toBe(inText)
    }
  })

  it('is a plain text selection between two text positions', () => {
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create(null, schema.text('One')),
      schema.nodes.paragraph.create(null, schema.text('Two')),
    ])
    const sel = extendTo(doc, 2, 7, 1)
    expect([sel.anchor, sel.head]).toEqual([2, 7])
  })
})
