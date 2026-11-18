import { getSchema } from '@tiptap/core'
import { describe, expect, it } from 'vitest'
import { countManuscript, createEditorExtensions } from '@/features/editor'
import { countText } from '@/shared/text'
import { buildManuscript } from '../ir/build'
import { FEATURE_FIXTURE_DOC, FEATURE_FIXTURE_FOOTNOTES, FEATURE_FIXTURE_STYLES } from '../ir/fixtures'
import { renderDocx } from './build'
import { parseXml, pStyle, pText, testSettings, unzipDocx, wAll, wAttr } from './test-helpers'
import { manuscriptWordCount } from '../ir/word-count'

// Word-count parity (deferred from Wave 1): the exported word count equals countManuscript on the same
// document. Counted from the IR's runs (manuscriptPlainText would count the list markers: 90 vs 88).

const schema = getSchema(createEditorExtensions())
const ir = buildManuscript(FEATURE_FIXTURE_DOC, FEATURE_FIXTURE_STYLES, { footnotes: FEATURE_FIXTURE_FOOTNOTES })
const live = countManuscript(schema.nodeFromJSON(FEATURE_FIXTURE_DOC))

/** Text paragraphs of the .docx (after the title page), as the words a reader sees: generated markers left out. */
function docxWords(files: Record<string, string>) {
  const document = parseXml(files['word/document.xml'])
  const paragraphs = Array.from(wAll(document, 'body')[0].children).filter((e) => e.localName === 'p')
  const text = paragraphs.slice(paragraphs.findIndex((p) => wAll(p, 'sectPr').length > 0) + 1)
  let body = 0
  for (const p of text) {
    const style = pStyle(p)
    if (style === 'SceneBreak' || style === 'EndMarker') continue
    const t = pText(p)
    body += countText(style === 'ListParagraph' ? t.slice(t.indexOf('\t') + 1) : t).words
  }
  const notes = parseXml(files['word/footnotes.xml'])
  const footnotes = wAll(notes, 'footnote')
    .filter((f) => !wAttr(f, 'type'))
    .reduce((n, f) => n + countText(pText(f)).words, 0)
  return { body, footnotes }
}

describe('DOCX word-count parity on the feature fixture', () => {
  it('the IR count equals countManuscript (body and footnotes)', () => {
    const count = manuscriptWordCount(ir)
    expect(count.body).toBe(live.body.words)
    expect(count.footnotes).toBe(live.footnotes.words)
    expect(count.total).toBe(live.body.words + live.footnotes.words)
  })

  it('the words in the exported .docx equal countManuscript', async () => {
    const files = unzipDocx(await renderDocx(ir, testSettings({ endMarker: 'the-end', sceneBreak: '* * *' })))
    expect(docxWords(files)).toEqual({ body: live.body.words, footnotes: live.footnotes.words })
  })

  it('the title page states the live count, rounded', async () => {
    const files = unzipDocx(await renderDocx(ir, testSettings({ wordCountRounding: 'exact' })))
    const first = wAll(parseXml(files['word/document.xml']), 'p')[0]
    const total = live.body.words + live.footnotes.words
    expect(pText(first)).toBe(`Ann Example\t${total} words`)
  })
})
