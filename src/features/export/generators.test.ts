import { describe, expect, it } from 'vitest'
import { parseXml, pText, unzipDocx, wAll } from './docx/test-helpers'
import { createManuscriptExportRenderers } from './generators'
import { buildManuscript, FEATURE_FIXTURE_DOC, FEATURE_FIXTURE_FOOTNOTES, FEATURE_FIXTURE_STYLES, manuscriptWordCount, type InlineRun, type ManuscriptIR } from './ir'
import type { RenderPdfOptions, RenderPdfResult } from './platform'
import type { PdfData, PdfRun } from './pdf'
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

describe('the DOCX and the PDF space sentences the same (one shared rule)', () => {
  // Abbreviations, initials, typed double spaces, a gap across runs (and across a run of only spaces),
  // a footnote reference after a full stop, and a line break.
  const runs: InlineRun[] = [
    { kind: 'text', text: 'Mr. Smith met J. R. R. Tolkien. He left, e.g. at noon.  Two spaces stay. It was ' },
    { kind: 'text', text: 'night', bold: true },
    { kind: 'text', text: '.' },
    { kind: 'text', text: ' ' },
    { kind: 'text', text: 'She', italic: true },
    { kind: 'text', text: ' went. "Why?" she asked.' },
    { kind: 'footnoteRef', footnote: 0 },
    { kind: 'text', text: ' Then home.' },
    { kind: 'lineBreak' },
    { kind: 'text', text: ' After the break. Done.' },
  ]
  const spacingIr: ManuscriptIR = structuredClone(ir)
  spacingIr.chapters[0].blocks.unshift({ kind: 'paragraph', role: 'body', runs })
  const job = (sentenceSpacing: 1 | 2): ExportJob => {
    const settings = { ...defaultManuscriptSettings('en-US'), sentenceSpacing }
    return { ir: spacingIr, settings, titlePage: titlePageData(settings, contact, 'The Long Night', 100) }
  }
  // A paragraph's text in the PDF data (the footnote reference left out, a line break as "\n", as pText).
  const pdfText = (r: PdfRun[]) => r.map((x) => ('s' in x ? x.s : 'br' in x ? '\n' : '')).join('')
  const typed = 'Mr. Smith met J. R. R. Tolkien. He left, e.g. at noon.  Two spaces stay. It was night. She went. "Why?" she asked. Then home.\n After the break. Done.'
  const classic = 'Mr. Smith met J. R. R. Tolkien.  He left, e.g. at noon.  Two spaces stay.  It was night.  She went.  "Why?" she asked.  Then home.\n After the break.  Done.'

  for (const sentenceSpacing of [1, 2] as const) {
    it(`${sentenceSpacing === 2 ? 'Classic' : 'Standard'}: the same text in both files`, async () => {
      const { renderers, pdfData } = setup()
      const docx = unzipDocx(await renderers.docx.render(job(sentenceSpacing)))
      await renderers.pdf.render(job(sentenceSpacing))
      const docxText = wAll(parseXml(docx['word/document.xml']), 'p')
        .map(pText)
        .find((t) => t.startsWith('Mr. Smith'))
      const pdfBlock = pdfData[0].blocks.find((b) => 'runs' in b && pdfText(b.runs).startsWith('Mr. Smith'))
      expect(pdfBlock && 'runs' in pdfBlock ? pdfText(pdfBlock.runs) : undefined).toBe(docxText)
      expect(docxText).toBe(sentenceSpacing === 2 ? classic : typed)
    })
  }
})
