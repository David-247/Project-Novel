import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FIXTURE_MANUSCRIPT_IR, type ManuscriptIR } from '../ir'
import { applyPreset, defaultManuscriptSettings, runningHeader, type HeaderFormat, type ManuscriptSettings } from '../settings'
import { applySentenceSpacing, buildPdfData, headerPrefix, PDF_TEMPLATE_ID, type ManuscriptMeta, type PdfBlock, type PdfRun } from './data'
import { fontRoleOf, lineMetrics } from './metrics'

const ROOT = resolve(__dirname, '../../../..')
const META: ManuscriptMeta = {
  title: 'The Long Night',
  contact: { legalName: 'Perry Slaughter', penName: '', address: '123 Main Street\n\n  Springfield, IL 62701  ', phone: '(555) 555-0100', email: 'perry@example.com', agent: 'Ann Agent\nAgency Ltd' },
}
const settings = (): ManuscriptSettings => defaultManuscriptSettings('en-US')
const ir = (): ManuscriptIR => structuredClone(FIXTURE_MANUSCRIPT_IR)
const texts = (runs: PdfRun[]) => runs.map((r) => ('s' in r ? r.s : 'br' in r ? '\n' : `[${r.n}]`)).join('')

describe('line metrics (docs/manuscript-format.md, "Line spacing")', () => {
  it('Times 12 pt double: pitch 27.60, line box 13.29, leading 14.31; Courier: 27.19, 13.59, 13.60', () => {
    expect(lineMetrics('serif', 12, 2)).toMatchObject({ pitch: 27.598, box: 13.289, leading: 14.309 })
    // Liberation Mono / Courier New hhea: 1705 + 615 units (docs round the box to 13.59 pt and the gap to 13.60).
    expect(lineMetrics('mono', 12, 2)).toMatchObject({ pitch: 27.188, box: 13.594, leading: 13.594 })
    expect(lineMetrics('serif', 12, 1.5).pitch).toBeCloseTo(20.7, 2)
    expect(lineMetrics('mono', 12, 1.5).pitch).toBeCloseTo(20.39, 2)
    expect(lineMetrics('serif', 12, 1).leading).toBeCloseTo(13.8 - 13.29, 2)
  })

  it('maps the (untrimmed) settings font to the engine role', () => {
    expect(fontRoleOf('  Courier New ')).toBe('mono')
    expect(fontRoleOf('Cousine')).toBe('mono')
    expect(fontRoleOf(' Times New Roman')).toBe('serif')
    expect(fontRoleOf('Garamond')).toBe('serif')
  })
})

describe('buildPdfData', () => {
  it('page, type and title page from the Standard preset on Letter', () => {
    const d = buildPdfData(ir(), settings(), META)
    expect(d.page).toEqual({ paper: 'us-letter', margin: { top: 72, right: 72, bottom: 72, left: 72 } })
    expect(d.type).toMatchObject({ size: 12, pitch: 27.598, leading: 14.309, indent: 36, topEdge: 0.8911, bottomEdge: -0.2163 })
    expect(d.titlePage).toEqual({
      contact: ['Perry Slaughter', '123 Main Street', 'Springfield, IL 62701', '(555) 555-0100', 'perry@example.com'],
      wordCount: 'about 100 words',
      title: 'The Long Night',
      byline: 'A Novel by Perry Slaughter',
      drop: 216,
    })
    expect(d.chapterDrop).toBe(216)
    expect(d.header).toEqual({ show: true, prefix: 'Slaughter / The Long Night / ', from: 2, offset: 1, ascent: 22.71 })
    expect(d.document).toEqual({ title: 'The Long Night', author: 'Perry Slaughter', lang: 'en' })
    expect(d.endMarker).toBe('')
  })

  it('A4: the drops are a third of its 9.69 in text area', () => {
    const d = buildPdfData(ir(), { ...settings(), paper: 'a4' }, META)
    expect(d.page.paper).toBe('a4')
    expect(d.titlePage!.drop).toBeCloseTo((841.89 - 144) / 3, 1)
  })

  it('trims fontFamily, sceneBreak and shortTitle at use (settings keep them as typed)', () => {
    const s = { ...settings(), fontFamily: '  Courier New  ', sceneBreak: '  * * *  ', header: { ...settings().header, shortTitle: '  Night  ' } }
    const d = buildPdfData(ir(), s, { ...META, title: '  The Long Night  ' })
    expect(d.type.leading).toBeCloseTo(13.6, 1)
    const scenes = d.blocks.filter((b) => b.t === 'scene')
    expect(scenes.length).toBeGreaterThan(1)
    expect(scenes.every((b) => b.text === '* * *')).toBe(true)
    expect(d.header.prefix).toBe('Slaughter / Night / ')
    expect(d.document.title).toBe('The Long Night')
    expect(buildPdfData(ir(), { ...settings(), sceneBreak: '   ' }, META).blocks.find((b) => b.t === 'scene')).toEqual({ t: 'scene', text: '#' })
  })

  it('the header prefix matches runningHeader for every format; title case and pen name', () => {
    for (const format of ['surname-title-page', 'title-surname-page', 'surname-page', 'page'] as HeaderFormat[]) {
      for (const titleCase of ['as-typed', 'upper'] as const) {
        const h = { format, titleCase }
        expect(headerPrefix(h, 'Slaughter', 'Silvertide') + '13').toBe(runningHeader(h, { surname: 'Slaughter', shortTitle: 'Silvertide', page: 13 }))
      }
    }
    const d = buildPdfData(ir(), { ...settings(), header: { ...settings().header, titleCase: 'upper' } }, { ...META, contact: { ...META.contact, penName: 'P. J. Night Jr.' } })
    expect(d.header.prefix).toBe('Night / THE LONG NIGHT / ')
    expect(d.titlePage!.byline).toBe('A Novel by P. J. Night Jr.')
    expect(buildPdfData(ir(), { ...settings(), header: { ...settings().header, format: 'none' } }, META).header.show).toBe(false)
  })

  it('header start: from the first text page numbered 1; startPage 1 numbers every page; no title page', () => {
    const s = settings()
    expect(buildPdfData(ir(), { ...s, header: { ...s.header, startPage: 1 } }, META).header).toMatchObject({ from: 1, offset: 0 })
    const none = buildPdfData(ir(), { ...s, titlePage: { ...s.titlePage, include: false } }, META)
    expect(none.titlePage).toBeNull()
    expect(none.header).toMatchObject({ from: 1, offset: 0 })
  })

  it('title page switches: contact, agent, word count, by-line style, rounding', () => {
    const s = settings()
    const d = buildPdfData(ir(), { ...s, titlePage: { ...s.titlePage, showAgent: true, bylineStyle: 'by' }, wordCountRounding: 'exact' }, { ...META, wordCount: 82_260 })
    expect(d.titlePage!.contact.slice(-2)).toEqual(['Ann Agent', 'Agency Ltd'])
    expect(d.titlePage!.wordCount).toBe('82,260 words')
    expect(d.titlePage!.byline).toBe('by Perry Slaughter')
    const off = buildPdfData(ir(), { ...s, titlePage: { ...s.titlePage, showContact: false, showWordCount: false, bylineStyle: 'name-only' } }, META)
    expect(off.titlePage).toMatchObject({ contact: [], wordCount: '', byline: 'Perry Slaughter' })
  })

  it('blocks: chapter openings with number and title lines, roles, scene breaks, footnotes at the reference', () => {
    const d = buildPdfData(ir(), settings(), META)
    const openings = d.blocks.filter((b): b is Extract<PdfBlock, { t: 'opening' }> => b.t === 'opening')
    // Four chapters and the part title.
    expect(openings.map((o) => o.lines.map(texts))).toEqual([['Chapter One', 'The Arrival'], ['The Storm'], ['Part Two'], [], ['Epilogue']])
    const first = d.blocks.find((b) => b.t === 'p' && texts(b.runs).startsWith('It was night'))!
    expect(first).toMatchObject({ t: 'p', align: 'left', indent: true })
    expect(texts((first as { runs: PdfRun[] }).runs)).toBe('It was night.[1] The rain fell hard and cold.')
    const note = (first as { runs: PdfRun[] }).runs.find((r) => 'fn' in r)
    expect(note).toEqual({ n: '1', fn: [{ s: 'First told in ' }, { s: '1902', i: true }, { s: '.' }] })
    expect(d.blocks.find((b) => b.t === 'li')).toMatchObject({ marker: '•', pad: 36, hang: 18 })
    expect(d.blocks.find((b) => b.t === 'p' && texts(b.runs) === 'Dear Ann, come home.')).toMatchObject({ indent: false, pad: [36, 36] })
    expect(d.blocks.find((b) => b.t === 'p' && texts(b.runs) === '— end of part one —')).toMatchObject({ align: 'right', indent: false })
    expect(d.blocks.filter((b) => b.t === 'page').length).toBeGreaterThan(0)
  })

  it('first paragraphs follow indentFirstParagraph', () => {
    const firstOf = (s: ManuscriptSettings) => buildPdfData(ir(), s, META).blocks.find((b) => b.t === 'p' && texts(b.runs) === 'Morning came.')
    expect(firstOf(settings())).toMatchObject({ indent: true })
    expect(firstOf({ ...settings(), indentFirstParagraph: false })).toMatchObject({ indent: false })
  })

  it('emphasis: italics or underline per preset; bold and underline kept', () => {
    const runOf = (s: ManuscriptSettings, text: string) =>
      buildPdfData(ir(), s, META)
        .blocks.flatMap((b) => ('runs' in b ? b.runs : []))
        .find((r) => 's' in r && r.s === text)
    expect(runOf(settings(), 'cold')).toEqual({ s: 'cold', i: true })
    expect(runOf(settings(), 'hard')).toEqual({ s: 'hard', u: true })
    expect(runOf(settings(), 'night')).toEqual({ s: 'night', b: true })
    const classic = applyPreset(settings(), 'classic')
    expect(runOf(classic, 'cold')).toEqual({ s: 'cold', u: true })
  })

  it('sentence spacing: two spaces after a sentence in Classic, across runs; one in Standard', () => {
    const runs: PdfRun[] = [{ s: 'It was ' }, { s: 'night', b: true }, { s: '.' }, { s: ' She  left. "Go!"   he said. Mr. X' }]
    expect(applySentenceSpacing(runs, 2).map((r) => ('s' in r ? r.s : '')).join('|')).toBe('It was |night|.|  She  left.  "Go!"  he said.  Mr.  X')
    expect(applySentenceSpacing(runs, 1).map((r) => ('s' in r ? r.s : '')).join('|')).toBe('It was |night|.| She  left. "Go!" he said. Mr. X')
    // A run of only spaces after the sentence's end is the gap itself.
    const spaced: PdfRun[] = [{ s: 'night.' }, { s: ' ' }, { s: 'She', i: true }, { s: ' went.' }]
    expect(applySentenceSpacing(spaced, 2).map((r) => ('s' in r ? r.s : '')).join('|')).toBe('night.|  |She| went.')
    expect(applySentenceSpacing([{ s: 'night.' }, { s: '   ' }, { s: 'She' }], 1).map((r) => ('s' in r ? r.s : '')).join('|')).toBe('night.| |She')
    const d = buildPdfData(ir(), applyPreset(settings(), 'classic'), META)
    const p = d.blocks.find((b) => b.t === 'p' && texts(b.runs).startsWith('It was night'))!
    expect(texts((p as { runs: PdfRun[] }).runs)).toBe('It was night.[1]  The rain fell hard and cold.')
  })

  it('end marker, language, no mutation of the inputs', () => {
    const input = ir()
    const s = { ...settings(), endMarker: 'the-end' as const }
    const frozen = structuredClone(s)
    const d = buildPdfData(input, s, { ...META, language: 'fr-CA' })
    expect(d.endMarker).toBe('THE END')
    expect(d.document.lang).toBe('fr')
    expect(buildPdfData(input, s, { ...META, language: 'not a tag!' }).document.lang).toBe('en')
    expect(input).toEqual(FIXTURE_MANUSCRIPT_IR)
    expect(s).toEqual(frozen)
  })

  it('rejects an IR version it does not know', () => {
    expect(() => buildPdfData({ ...ir(), version: 2 } as unknown as ManuscriptIR, settings(), META)).toThrow(/Unsupported manuscript IR version/)
  })
})

describe('the bundled template (src-tauri/templates/manuscript.typ)', () => {
  // (CRLF on a Windows checkout: the snapshots compare the text, not the line endings.)
  const source = readFileSync(join(ROOT, 'src-tauri', 'templates', 'manuscript.typ'), 'utf8').replace(/\r\n/g, '\n')

  it('is registered under the fixed id and needs no package or eval (offline)', () => {
    const registry = readFileSync(join(ROOT, 'src-tauri', 'src', 'export', 'templates.rs'), 'utf8')
    expect(registry).toContain(`id: "${PDF_TEMPLATE_ID}", source: include_str!("../../templates/manuscript.typ")`)
    expect(source).not.toMatch(/"@|@preview\/|@local\/|eval\(|#import|#include/)
  })

  it('shows manuscript text only through text(), never as markup', () => {
    expect(source).not.toMatch(/eval\(|raw\(|read\(/)
    expect(source).toMatchSnapshot()
  })

  it('data snapshot: the feature fixture (src-tauri/templates/manuscript.sample.json, also rendered by cargo test)', () => {
    const path = join(ROOT, 'src-tauri', 'templates', 'manuscript.sample.json')
    const data = JSON.stringify(buildPdfData(ir(), settings(), META), null, 2) + '\n'
    if (process.env.UPDATE_PDF_SAMPLE === '1') writeFileSync(path, data)
    const stored = readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
    expect(stored, 'stale sample: rerun with UPDATE_PDF_SAMPLE=1').toBe(data)
  })
})
