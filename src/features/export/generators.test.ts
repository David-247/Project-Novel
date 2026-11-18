import { describe, expect, it } from 'vitest'
import { parseXml, pText, unzipDocx, wAll } from './docx/test-helpers'
import { createManuscriptExportRenderers } from './generators'
import { buildManuscript, FEATURE_FIXTURE_DOC, FEATURE_FIXTURE_FOOTNOTES, FEATURE_FIXTURE_STYLES, manuscriptWordCount } from './ir'
import type { RenderPdfOptions, RenderPdfResult } from './platform'
import type { PdfData } from './pdf'
import { defaultManuscriptSettings, formatWordCount, type ContactDetails, type WordCountRounding } from './settings'
import { titlePageData, titlePageWordCount, type ExportJob } from './wizard'

// One title-page word count for both formats (coordinator ruling, docs/manuscript-format.md "take the
// app's word count"): the wizard counts once, footnotes included exactly when Word Count's "Include
// footnotes" is on, and both generators print that number.

const contact: ContactDetails = { legalName: 'Ann Waight', penName: '', address: '1 Quay Street', phone: '', email: 'ann@example.com', agent: '' }
const ir = buildManuscript(FEATURE_FIXTURE_DOC, FEATURE_FIXTURE_STYLES, { footnotes: FEATURE_FIXTURE_FOOTNOTES })

function setup() {
  const pdfData: PdfData[] = []
  const render = async (o: RenderPdfOptions): Promise<RenderPdfResult> => {
    pdfData.push(o.data as PdfData)
    const pdf = new Uint8Array([37, 80, 68, 70])
    return { font: { requested: 'Times New Roman', family: 'Liberation Serif', source: 'bundled', embedded: [] }, warnings: [], bytes: pdf.length, pdf }
  }
  return { renderers: createManuscriptExportRenderers({ docx: { worker: 'never' }, pdf: { render } }), pdfData }
}

async function printedCounts(includeFootnotes: boolean, rounding: WordCountRounding) {
  const settings = { ...defaultManuscriptSettings('en-US'), wordCountRounding: rounding }
  const titlePage = titlePageData(settings, contact, 'The Long Night', titlePageWordCount(ir, includeFootnotes))
  const job: ExportJob = { ir, settings, titlePage }
  const { renderers, pdfData } = setup()
  const docx = unzipDocx(await renderers.docx.render(job))
  // The title page's first line: the legal name, a tab, then the count.
  const first = pText(wAll(parseXml(docx['word/document.xml']), 'p')[0])
  await renderers.pdf.render(job)
  return { docx: first.slice(first.indexOf('\t') + 1), pdf: pdfData[0].titlePage!.wordCount, expected: titlePage.wordCountText }
}

describe('the title-page word count is the same in the DOCX and the PDF', () => {
  const wc = manuscriptWordCount(ir)

  it('the fixture has footnote words (so the setting matters)', () => {
    expect(wc.footnotes).toBeGreaterThan(0)
    expect(titlePageWordCount(ir, true)).toBe(wc.total)
    expect(titlePageWordCount(ir, false)).toBe(wc.body)
  })

  for (const includeFootnotes of [true, false]) {
    it(`"Include footnotes" ${includeFootnotes ? 'on' : 'off'}: both print the same "about N words", and the exact count`, async () => {
      const about = await printedCounts(includeFootnotes, 'auto')
      expect(about.docx).toMatch(/^about \d[\d,]* words$/)
      expect(about.pdf).toBe(about.docx)
      expect(about.docx).toBe(about.expected)
      const exact = await printedCounts(includeFootnotes, 'exact')
      const n = includeFootnotes ? wc.total : wc.body
      expect(exact.docx).toBe(formatWordCount(n, 'exact'))
      expect(exact.pdf).toBe(exact.docx)
    })
  }
})
