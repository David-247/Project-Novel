import { getSchema } from '@tiptap/core'
import { describe, expect, it } from 'vitest'
import { countManuscript, createEditorExtensions } from '@/features/editor'
import { buildPaginationFixture } from '../../../../e2e/fixtures/pagination-manuscript'
import { buildManuscript, FEATURE_FIXTURE_DOC, FEATURE_FIXTURE_FOOTNOTES, FEATURE_FIXTURE_STYLES } from '../ir'
import { defaultManuscriptSettings, formatWordCount } from '../settings'
import { buildPdfData } from './data'
import { manuscriptWordCount } from './word-count'

// Word-count parity (deferred W1 item for T6): the count the PDF's title page states, taken from the
// IR's runs (not manuscriptPlainText, which adds list markers), equals the live word count
// (countManuscript, body words) on the same document.
const schema = getSchema(createEditorExtensions())
const contact = { legalName: 'Perry Slaughter', penName: '', address: '', phone: '', email: '', agent: '' }

describe('PDF word count = countManuscript', () => {
  it('the feature fixture (tracked changes accepted, footnotes and list markers left out)', () => {
    const ir = buildManuscript(FEATURE_FIXTURE_DOC, FEATURE_FIXTURE_STYLES, { footnotes: FEATURE_FIXTURE_FOOTNOTES })
    const live = countManuscript(schema.nodeFromJSON(FEATURE_FIXTURE_DOC))
    expect(manuscriptWordCount(ir)).toBe(live.body.words)
    const settings = { ...defaultManuscriptSettings('en-US'), wordCountRounding: 'exact' as const }
    expect(buildPdfData(ir, settings, { title: 'T', contact }).titlePage!.wordCount).toBe(formatWordCount(live.body.words, 'exact'))
  })

  it('the 100k-word fixture', () => {
    const fixture = buildPaginationFixture()
    const doc = schema.nodeFromJSON(fixture.doc)
    const ir = buildManuscript(doc, {})
    expect(manuscriptWordCount(ir)).toBe(countManuscript(doc).body.words)
    expect(manuscriptWordCount(ir)).toBe(fixture.words)
  })
})
