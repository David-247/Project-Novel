import { getSchema } from '@tiptap/core'
import { describe, expect, it } from 'vitest'
import { createEditorExtensions } from '@/features/editor'
import { locateInDoc } from './locate'
import { WIZARD_FIXTURE_DOC } from './fixtures'

const schema = getSchema(createEditorExtensions())

describe('locateInDoc', () => {
  const doc = schema.nodeFromJSON(WIZARD_FIXTURE_DOC)
  const at = locateInDoc(doc)

  it('finds the first two spaces after a full stop (the range of the whole gap)', () => {
    expect(at.doubleSpace).not.toBeNull()
    const { from, to } = at.doubleSpace!
    expect(doc.textBetween(from - 'waited.'.length, from)).toBe('waited.')
    expect(doc.textBetween(from, to)).toBe('  ')
    expect(doc.textBetween(to, to + 6)).toBe('Nobody')
  })

  it('finds the first book formatting the export leaves out (the run in Georgia)', () => {
    expect(at.formatting).not.toBeNull()
    expect(doc.nodeAt(at.formatting!)?.text).toBe(' and ')
  })

  it('finds nothing in a plain document; a gap across two runs is not located', () => {
    const plain = schema.nodeFromJSON({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'One.', marks: [{ type: 'italic' }] }, { type: 'text', text: '  Two.' }] }],
    })
    expect(locateInDoc(plain)).toEqual({ doubleSpace: null, formatting: null })
  })

  it('a paragraph with its own line height is book formatting', () => {
    const d = schema.nodeFromJSON({ type: 'doc', content: [{ type: 'paragraph', attrs: { lineHeight: '2' }, content: [{ type: 'text', text: 'Hi.' }] }] })
    expect(locateInDoc(d).formatting).toBe(1)
  })
})
