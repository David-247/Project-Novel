import type { DocJSON, DocNodeJSON } from '@/shared/document'
import { FEATURE_FIXTURE_DOC } from '../ir'

/**
 * The export wizard's fixture: the IR's feature fixture (FEATURE_FIXTURE_DOC: pending tracked changes,
 * comments, an open re-write, manual and blank scene breaks, stripped fonts, an untitled and an empty
 * chapter) plus the two things the wizard checks that it lacks: two spaces after a full stop (in
 * chapter 1) and a chapter-numbering gap ("Chapter One" ... "Chapter Three" before the Epilogue). With
 * its side files, every check of the wizard fires on it.
 */

const p = (text: string): DocNodeJSON => ({ type: 'paragraph', content: [{ type: 'text', text }] })

function wizardDoc(): DocJSON {
  const content = [...(FEATURE_FIXTURE_DOC.content ?? [])]
  // Two spaces after a full stop: after "Boats rocked." in chapter 1.
  const boats = content.findIndex((n) => n.content?.[0]?.text === 'Boats rocked.')
  content.splice(boats + 1, 0, p('He waited.  Nobody came.'))
  // A chapter number before the last chapter (Epilogue): One, (unnumbered), (untitled), Three.
  const epilogue = content.findIndex((n) => n.type === 'heading' && n.content?.[0]?.text === 'Epilogue')
  content.splice(epilogue, 0, { type: 'heading', attrs: { level: 1, styleId: 'chapter-number' }, content: [{ type: 'text', text: 'Chapter Three' }] })
  return { ...FEATURE_FIXTURE_DOC, content }
}

export const WIZARD_FIXTURE_DOC: DocJSON = wizardDoc()

const DATE = '2026-11-01T10:00:00.000Z'
const thread = (id: string, text: string) => ({
  id,
  createdAt: DATE,
  author: 'Ann',
  resolved: false,
  messages: [{ id: `${id}-m`, author: 'Ann', date: DATE, text }],
})

/** comments.json for the fixture's two comment anchors (k1, k2). */
export const WIZARD_FIXTURE_COMMENTS = { version: 1, threads: [thread('k1', 'Too abrupt?'), thread('k2', 'Louder.')] }

/** rewrites.json for the fixture's open re-write (rw-1: "The tide turned." / "They went home."). */
export const WIZARD_FIXTURE_REWRITES = {
  version: 1,
  rewrites: [
    {
      id: 'rw-1',
      createdAt: DATE,
      anchor: 'rw-1',
      original: { type: 'doc', content: [p('The tide turned.'), p('They went home.')] },
      versions: [{ id: 'v-1', name: 'Version 1', updatedAt: DATE, doc: { type: 'doc', content: [p('The tide turned at last.'), p('They went home.')] } }],
      status: 'open',
    },
  ],
}

/** The fixture's book.json styles (the custom chapter style based on Chapter Title). */
export { FEATURE_FIXTURE_STYLES as WIZARD_FIXTURE_STYLES } from '../ir'
