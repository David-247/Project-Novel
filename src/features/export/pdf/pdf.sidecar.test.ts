// @vitest-environment node
/**
 * The PDF manuscript, rendered for real: the bundled template (src-tauri/templates/manuscript.typ)
 * with the Typst sidecar and the bundled fonts, read back with pdfjs-dist. Runs wherever
 * `pnpm fetch:typst` has run; CI's Rust job (macOS and Windows) runs it with NOVEL_REQUIRE_TYPST=1.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildPaginationFixture } from '../../../../e2e/fixtures/pagination-manuscript'
import { buildManuscript, FEATURE_FIXTURE_DOC, FEATURE_FIXTURE_FOOTNOTES, FEATURE_FIXTURE_STYLES } from '../ir'
import type { ManuscriptIR } from '../ir'
import { applyPreset, defaultManuscriptSettings, formatWordCount, type ManuscriptSettings } from '../settings'
import { buildPdfData, type ManuscriptMeta } from './data'
import { FONT_METRICS } from './metrics'
import { readPdf, renderWithSidecar, REQUIRE_TYPST, ROOT, SIDECAR, type PdfPage, type ReadPdf } from './test-harness'
import { manuscriptWordCount } from './word-count'

const enabled = SIDECAR !== null || REQUIRE_TYPST

const META: ManuscriptMeta = {
  title: 'The Long Night',
  contact: {
    legalName: 'Perry Slaughter',
    penName: '',
    address: '123 Main Street\nSpringfield, IL 62701',
    phone: '(555) 555-0100',
    email: 'perry@example.com',
    agent: '',
  },
  language: 'en-US',
}

const letter = (): ManuscriptSettings => defaultManuscriptSettings('en-US')
const featureIR = (): ManuscriptIR => buildManuscript(FEATURE_FIXTURE_DOC, FEATURE_FIXTURE_STYLES, { footnotes: FEATURE_FIXTURE_FOOTNOTES })

/** Baselines on a page, in pt from the top edge, of lines inside the text area (not the header). */
const bodyLines = (page: PdfPage, topMargin = 72) => page.lines.filter((l) => page.height - l.y > topMargin)
const fromTop = (page: PdfPage, y: number) => page.height - y

describe.skipIf(!enabled)('PDF manuscript (real Typst sidecar + pdfjs)', () => {
  it('is required on CI where the sidecar was fetched', () => {
    expect(SIDECAR, 'the Typst sidecar is missing: run `pnpm fetch:typst`').not.toBeNull()
  })

  describe('the feature fixture (Standard preset, Letter)', () => {
    const ir = featureIR()
    const settings = letter()
    let doc: ReadPdf
    let title: PdfPage
    let body: PdfPage[]
    beforeAll(async () => {
      const { pdf } = await renderWithSidecar(buildPdfData(ir, settings, META))
      doc = await readPdf(pdf)
      ;[title, ...body] = doc.pages
    }, 60_000)

    it('has PDF metadata: title, author, language; embeds the bundled fonts', () => {
      expect(doc.info.Title).toBe('The Long Night')
      expect(doc.info.Author).toBe('Perry Slaughter')
      expect(doc.info.Language).toBe('en')
      expect(doc.fonts).toContain('LiberationSerif')
      expect(doc.fonts).toContain('LiberationSerif-Italic')
      expect(doc.fonts.every((f) => f.startsWith('LiberationSerif'))).toBe(true)
    })

    it('title page: contact block upper left, word count upper right, title a third down, by-line, no header', () => {
      expect(title.lines.map((l) => l.text)).toEqual([
        expect.stringMatching(/^Perry Slaughter\s*about \d[\d,]* words$/),
        '123 Main Street',
        'Springfield, IL 62701',
        '(555) 555-0100',
        'perry@example.com',
        'The Long Night',
        'A Novel by Perry Slaughter',
      ])
      expect(title.text).toContain(formatWordCount(manuscriptWordCount(ir), 'auto'))
      // First line at the top margin (baseline = 1 in + ascender), flush left; word count flush right.
      const first = title.items.find((i) => i.str.startsWith('Perry'))!
      expect(first.x).toBeCloseTo(72, 1)
      expect(fromTop(title, first.y)).toBeCloseTo(72 + 12 * FONT_METRICS.serif.ascender, 1)
      const wc = title.items.find((i) => i.str.startsWith('about'))!
      expect(wc.x + wc.width).toBeCloseTo(612 - 72, 0)
      // Title: a third of the 9 in text area below the top margin (3 in), centred; by-line two lines below.
      const t = title.lines.find((l) => l.text === 'The Long Night')!
      expect(fromTop(title, t.y)).toBeCloseTo(72 + 216 + 12 * FONT_METRICS.serif.ascender, 1)
      const tItem = title.items.find((i) => i.str === 'The Long Night')!
      expect(tItem.x + tItem.width / 2).toBeCloseTo(306, 0)
      const by = title.lines.find((l) => l.text.startsWith('A Novel by'))!
      expect(t.y - by.y).toBeCloseTo(2 * 27.6, 1)
      // No header: nothing above the top margin, no page number.
      expect(title.lines.filter((l) => fromTop(title, l.y) < 72)).toEqual([])
    })

    it('every body page has the running header "Slaughter / The Long Night / n", flush right, numbered from 1', () => {
      expect(body.length).toBeGreaterThanOrEqual(5)
      body.forEach((page, i) => {
        const header = page.lines[0]
        expect(header.text).toBe(`Slaughter / The Long Night / ${i + 1}`)
        // 0.5 in from the top edge (line box top), right-aligned at the margin.
        expect(fromTop(page, header.y)).toBeCloseTo(36 + 12 * FONT_METRICS.serif.ascender, 1)
        const last = page.items.filter((it) => Math.abs(it.y - header.y) < 0.6).sort((a, b) => b.x - a.x)[0]
        expect(last.x + last.width).toBeCloseTo(612 - 72, 0)
      })
    })

    it('each chapter starts on a new page, its heading a third down, centred; the chapter count matches', () => {
      const openings = ir.chapters.map((c) => [c.numberText, c.titleText].filter(Boolean).join(' / '))
      const pagesWith = (s: string) => body.filter((p) => bodyLines(p).some((l) => l.text === s))
      let chaptersFound = 0
      for (const c of ir.chapters) {
        const headingLine = c.numberText || c.titleText
        if (!headingLine) continue
        const pages = pagesWith(headingLine)
        expect(pages, headingLine).toHaveLength(1)
        const page = pages[0]
        const first = bodyLines(page)[0]
        expect(first.text, `${headingLine} opens its page`).toBe(headingLine)
        expect(fromTop(page, first.y)).toBeCloseTo(72 + 216 + 12 * FONT_METRICS.serif.ascender, 1)
        chaptersFound++
      }
      expect(chaptersFound).toBe(ir.chapters.filter((c) => c.numberText || c.titleText).length)
      expect(openings.length).toBe(ir.chapters.length)
      // The untitled chapter opens a page of its own too: its first text line is dropped like a heading's.
      const untitled = pagesWith('Nothing has a name here.')[0]
      expect(fromTop(untitled, bodyLines(untitled)[0].y)).toBeCloseTo(72 + 216 + 27.6 + 12 * FONT_METRICS.serif.ascender, 1)
    })

    it('double spacing: every text line of a body page sits on a 27.60 pt grid (Times: leading 14.31 pt)', () => {
      for (const page of body) {
        const lines = bodyLines(page).filter((l) => fromTop(page, l.y) < 792 - 72 - 80) // above the footnote area
        for (let i = 1; i < lines.length; i++) {
          const gap = lines[i - 1].y - lines[i].y
          const steps = Math.round(gap / 27.6)
          expect(Math.abs(gap - steps * 27.6), `page ${page.number}: ${lines[i].text}`).toBeLessThan(0.1 * steps + 0.01)
        }
      }
    })

    it('scene breaks print the preset marker centred; the manuscript text prints with its emphasis', () => {
      const all = body.flatMap((p) => p.lines.map((l) => l.text))
      expect(all.filter((l) => l === '#').length).toBe(ir.chapters.flatMap((c) => c.blocks).filter((b) => b.kind === 'sceneBreak').length)
      const page = body.find((p) => p.text.includes('Arrival'))!
      const italic = page.items.find((i) => i.str.includes('Arrival'))!
      const regular = page.items.find((i) => i.str.startsWith('It was'))!
      expect(italic.font).not.toBe(regular.font)
    })

    it('footnotes: the text is at the foot of the page of its reference, numbered, the reference on the same page', () => {
      expect(ir.footnotes.length).toBeGreaterThan(0)
      for (const note of ir.footnotes) {
        const text = note.runs.map((r) => (r.kind === 'text' ? r.text : ' ')).join('')
        const pages = body.filter((p) => p.lines.some((l) => l.text === text))
        expect(pages, text).toHaveLength(1)
        const page = pages[0]
        const line = page.lines.find((l) => l.text === text)!
        // At the foot: the last line of the page, its descender on the bottom margin.
        expect(page.lines[page.lines.length - 1]).toBe(line)
        expect(fromTop(page, line.y) + 12 * FONT_METRICS.serif.descender).toBeCloseTo(792 - 72, 0)
        const num = String(note.number)
        const small = page.items.filter((i) => i.str === num && i.size < 12)
        // The entry's number, raised, left of the text ...
        expect(small.some((i) => i.x < line.x && i.y > line.y && i.y - line.y < 8), `entry number ${num}`).toBe(true)
        // ... and the reference in the text above, on the same page.
        expect(small.some((i) => i.y > line.y + 27), `reference ${num}`).toBe(true)
      }
    })

    it('word count parity: the title page states the IR word count', () => {
      expect(title.text).toContain(formatWordCount(manuscriptWordCount(ir), settings.wordCountRounding))
    })
  })

  it('line pitch within 0.1 pt of the DOCX value: Times 27.60 pt (gap 14.31), Courier 27.19 pt (gap 13.60)', async () => {
    const para = Array.from({ length: 60 }, () => 'manuscript').join(' ')
    const ir: ManuscriptIR = {
      ...featureIR(),
      frontMatter: [],
      footnotes: [],
      chapters: [{ index: 0, number: [], numberText: '', title: [], titleText: '', titleStyleId: 'chapter-title', blocks: [{ kind: 'paragraph', role: 'body', runs: [{ kind: 'text', text: para }] }, { kind: 'paragraph', role: 'body', runs: [{ kind: 'text', text: para }] }] }],
    }
    for (const [preset, role, pitch, gap, box] of [
      ['standard', 'serif', 27.6, 14.31, 13.29],
      ['classic', 'mono', 27.19, 13.6, 13.59],
    ] as const) {
      const settings = { ...applyPreset(letter(), preset), titlePage: { ...letter().titlePage, include: false } }
      const { pdf } = await renderWithSidecar(buildPdfData(ir, settings, META), role)
      const page = (await readPdf(pdf)).pages[0]
      const lines = bodyLines(page)
      expect(lines.length).toBeGreaterThan(6)
      for (let i = 1; i < lines.length; i++) {
        const measured = lines[i - 1].y - lines[i].y
        expect(Math.abs(measured - pitch), `${preset} pitch`).toBeLessThan(0.1)
        // The gap between two line boxes (ascender to descender): what DOCX and Typst agree on.
        expect(Math.abs(measured - box - gap), `${preset} gap`).toBeLessThan(0.1)
      }
    }
  })

  it('manuscript text with Typst syntax prints literally (no injection)', async () => {
    const nasty = '#set page(fill: red) $x^2$ [link] *bold* _it_ @ref <label> \\ `raw` // not a comment /* nor */ = heading #import "@preview/x:1.0.0" #eval("1")'
    const ir: ManuscriptIR = {
      ...featureIR(),
      frontMatter: [],
      footnotes: [{ index: 0, number: 1, label: '1', chapter: 0, runs: [{ kind: 'text', text: '#footnote[$y$]' }] }],
      chapters: [
        {
          index: 0,
          number: [],
          numberText: '',
          title: [{ kind: 'text', text: '#strong[Title] $z$' }],
          titleText: '#strong[Title] $z$',
          titleStyleId: 'chapter-title',
          blocks: [
            { kind: 'paragraph', role: 'body', runs: [{ kind: 'text', text: nasty }] },
            { kind: 'sceneBreak', source: 'node', original: '' },
            { kind: 'paragraph', role: 'first', runs: [{ kind: 'text', text: 'Note' }, { kind: 'footnoteRef', footnote: 0 }] },
          ],
        },
      ],
    }
    const settings = letter()
    const meta = { ...META, title: '#title $t$ [x]', contact: { ...META.contact, legalName: '#name $n$' } }
    const { pdf } = await renderWithSidecar(buildPdfData(ir, { ...settings, sceneBreak: ' $#$ ', header: { ...settings.header, shortTitle: ' #[short] ' } }, meta))
    const doc = await readPdf(pdf)
    const all = doc.pages.map((p) => p.text).join('\n').replace(/\s+/g, ' ')
    expect(all).toContain(nasty.replace(/\s+/g, ' '))
    expect(all).toContain('#strong[Title] $z$')
    expect(all).toContain('#footnote[$y$]')
    expect(all).toContain('#title $t$ [x]')
    expect(all).toContain('#name $n$')
    expect(all).toContain('$#$')
    expect(doc.pages[1].lines[0].text).toBe('$n$ / #[short] / 1')
    expect(doc.info.Title).toBe('#title $t$ [x]')
  })

  it('the 100k-word fixture renders within the budget (15 s, blocking on Windows), every chapter on a new page', { timeout: 180_000 }, async () => {
    const fixture = buildPaginationFixture()
    const ir = buildManuscript(fixture.doc as Parameters<typeof buildManuscript>[0], {})
    const settings = letter()
    const data = buildPdfData(ir, settings, META)
    const { pdf, ms } = await renderWithSidecar(data)
    const doc = await readPdf(pdf)
    const [, ...body] = doc.pages
    const openings = body.filter((p) => /^Chapter \d+: /.test(bodyLines(p)[0]?.text ?? ''))
    expect(openings.length).toBe(fixture.chapters)
    body.forEach((p, i) => expect(p.lines[0].text).toBe(`Slaughter / The Long Night / ${i + 1}`))
    expect(doc.pages[0].text).toContain(formatWordCount(fixture.words, 'auto'))

    const result = { scenario: 'pdf-export', browser: 'typst', platform: process.platform, pdfRender: { ms, pages: doc.pages.length, bytes: pdf.length, words: fixture.words } }
    const dir = join(ROOT, 'perf-results')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `pdf-export-${process.platform}.json`), JSON.stringify(result, null, 2))
    console.log(`[pdf-export] 100k words: ${ms} ms, ${doc.pages.length} pages, ${pdf.length} bytes`)
    // Budget (decision 1cedc290): blocking on Windows; macOS CI records it (decision f040009b).
    if (process.platform === 'win32' || !process.env.CI) expect(ms, 'PDF render of 100k words (budget 15000 ms)').toBeLessThan(15_000)
    else if (ms >= 15_000) console.warn(`[perf-budget-warning] PDF render ${ms} ms >= 15000 ms on ${process.platform} (CI runner: reported, not blocking)`)
  })
})
