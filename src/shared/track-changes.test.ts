import { Schema, type Node as PMNode } from '@tiptap/pm/model'
import { describe, expect, it } from 'vitest'
import { acceptedText, isDeletedOnAccept, joinsPreviousOnAccept } from './track-changes'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*', attrs: { trackedDelete: { default: null }, trackedInsert: { default: null } } },
    sceneBreak: { group: 'block', atom: true, attrs: { trackedDelete: { default: null } } },
    text: { group: 'inline' },
    hardBreak: { group: 'inline', inline: true },
    note: { group: 'inline', inline: true, atom: true, content: 'text*' },
    glyph: { group: 'inline', inline: true, atom: true, leafText: () => '#' },
  },
  marks: { insertion: { excludes: '' }, deletion: { excludes: '' }, bold: {} },
})

const ins = schema.marks.insertion.create()
const del = schema.marks.deletion.create()
const t = (text: string, ...marks: ReturnType<typeof schema.mark>[]) => schema.text(text, marks)
const p = (children: PMNode[], attrs: Record<string, unknown> = {}) => schema.nodes.paragraph.create(attrs, children)

describe('accepted text (every pending tracked change accepted)', () => {
  it('keeps inserted text and leaves deleted text out, whatever other marks it has', () => {
    const block = p([t('The '), t('old', del), t('new', ins), t(' cat', schema.marks.bold.create())])
    expect(acceptedText(block)).toBe('The new cat')
  })

  it('text both inserted and deleted is gone', () => {
    expect(acceptedText(p([t('a'), t('x', ins, del), t('b')]))).toBe('ab')
  })

  it('skips nodes the caller names (with their content), and gives inline leaves their leaf text', () => {
    const note = schema.nodes.note.create(null, [t('note text')])
    const block = p([t('word'), note, t('.'), schema.nodes.glyph.create(), schema.nodes.hardBreak.create(), t('next')])
    expect(acceptedText(block, { skip: (n) => n.type.name === 'note' })).toBe('word.#next')
    expect(acceptedText(block, { skip: (n) => n.type.name === 'note', leafText: (n) => (n.type.name === 'hardBreak' ? '\n' : undefined) })).toBe('word.#\nnext')
  })

  it('a deleted inline atom goes with its content', () => {
    const note = schema.nodes.note.create(null, [t('gone')], [del])
    expect(acceptedText(p([t('a'), note, t('b')]))).toBe('ab')
  })

  it('isDeletedOnAccept / joinsPreviousOnAccept', () => {
    expect(isDeletedOnAccept(t('x', del))).toBe(true)
    expect(isDeletedOnAccept(t('x', ins))).toBe(false)
    expect(joinsPreviousOnAccept(p([t('x')], { trackedDelete: { id: '1' } }))).toBe(true)
    expect(joinsPreviousOnAccept(p([t('x')], { trackedInsert: { id: '1' } }))).toBe(false)
    expect(joinsPreviousOnAccept(schema.nodes.sceneBreak.create({ trackedDelete: { id: '1' } }))).toBe(true)
  })
})
