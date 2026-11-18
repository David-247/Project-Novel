import { describe, expect, it } from 'vitest'
import { FIXTURE_MANUSCRIPT_IR } from '../ir/fixtures'
import { MANUSCRIPT_IR_VERSION, type ManuscriptIR } from '../ir/types'
import { renderDocx } from './build'
import { parseXml, pStyle, pText, styleById, testSettings, unzipDocx, wAll, wAttr } from './test-helpers'
import type { DocxRenderSettings } from './types'

// XML assertions on the generated .docx (docs/docx-export.md; layout rules: docs/manuscript-format.md).

const NOW = new Date('2026-11-18T12:00:00.000Z')

async function render(settings: DocxRenderSettings = testSettings(), ir: ManuscriptIR = FIXTURE_MANUSCRIPT_IR) {
  const files = unzipDocx(await renderDocx(ir, settings, { now: NOW }))
  const document = parseXml(files['word/document.xml'])
  const styles = parseXml(files['word/styles.xml'])
  const body = wAll(document, 'body')[0]
  const paragraphs = Array.from(body.children).filter((e) => e.localName === 'p')
  // The title page section ends with a paragraph holding a sectPr.
  const titleEnd = paragraphs.findIndex((p) => wAll(p, 'sectPr').length > 0)
  return { files, document, styles, paragraphs, titlePage: paragraphs.slice(0, titleEnd + 1), text: paragraphs.slice(titleEnd + 1) }
}

const tinyIR = (patch: Partial<ManuscriptIR> = {}): ManuscriptIR => ({
  version: MANUSCRIPT_IR_VERSION,
  frontMatter: [],
  chapters: [{ index: 0, number: [], numberText: '', title: [{ kind: 'text', text: 'One' }], titleText: 'One', titleStyleId: 'chapter-title', blocks: [{ kind: 'paragraph', role: 'first', runs: [{ kind: 'text', text: 'Hello.' }] }] }],
  footnotes: [],
  report: FIXTURE_MANUSCRIPT_IR.report,
  ...patch,
})

describe('DOCX package', () => {
  it('has the document, styles, header, footnotes and properties parts, and no comments part', async () => {
    const { files } = await render()
    for (const part of ['[Content_Types].xml', 'word/document.xml', 'word/styles.xml', 'word/header1.xml', 'word/footnotes.xml', 'word/settings.xml', 'docProps/core.xml']) expect(files[part], part).toBeDefined()
    expect(Object.keys(files).some((k) => /comments/i.test(k))).toBe(false)
    for (const [path, text] of Object.entries(files)) if (path.endsWith('.xml') || path.endsWith('.rels')) parseXml(text)
  })

  it('has no tracked-change or comment markup anywhere', async () => {
    const { files } = await render()
    const all = Object.values(files).join('\n')
    for (const tag of ['w:ins ', 'w:ins>', 'w:del ', 'w:del>', 'w:delText', 'w:moveFrom', 'w:moveTo', 'w:rPrChange', 'w:pPrChange', 'w:sectPrChange', 'w:commentRangeStart', 'w:commentRangeEnd', 'w:commentReference', 'w:trackRevisions']) {
      expect(all.includes(`<${tag}`), tag).toBe(false)
    }
  })

  it('sets the document properties: title, author and language', async () => {
    const { files, styles } = await render()
    const core = parseXml(files['docProps/core.xml'])
    const text = (tag: string) => core.getElementsByTagName(tag)[0]?.textContent
    expect(text('dc:title')).toBe('The Long Night')
    expect(text('dc:creator')).toBe('Perry Slaughter')
    expect(text('cp:lastModifiedBy')).toBe('Perry Slaughter')
    expect(text('dc:language')).toBe('en-US')
    expect(text('dcterms:created')).toBe('2026-11-18T12:00:00Z')
    // The text's proofing language (docDefaults).
    expect(wAttr(wAll(wAll(styles, 'rPrDefault')[0], 'lang')[0], 'val')).toBe('en-US')
  })

  it('an empty title is "Untitled" on the title page and in the properties alike', async () => {
    const { files, titlePage } = await render(testSettings({}, { title: '   ' }))
    expect(titlePage.map(pText)).toContain('Untitled')
    expect(parseXml(files['docProps/core.xml']).getElementsByTagName('dc:title')[0].textContent).toBe('Untitled')
  })

  it('writes the language given, and falls back to en-US for a malformed tag', async () => {
    const gb = await render(testSettings({}, { language: 'en_GB' }))
    expect(parseXml(gb.files['docProps/core.xml']).getElementsByTagName('dc:language')[0].textContent).toBe('en-GB')
    const bad = await render(testSettings({}, { language: '<script>' }))
    expect(parseXml(bad.files['docProps/core.xml']).getElementsByTagName('dc:language')[0].textContent).toBe('en-US')
  })
})

describe('sections, page setup and the running header', () => {
  it('has a title page section with no header, then the text numbered from 1 with the header', async () => {
    const { document } = await render()
    const sects = wAll(document, 'sectPr')
    // Title page, front matter, 4 chapters, the part title.
    expect(sects).toHaveLength(7)
    const [title, text, ...rest] = sects
    expect(wAll(title, 'headerReference')).toHaveLength(0)
    expect(wAll(text, 'headerReference')).toHaveLength(1)
    expect(wAttr(wAll(text, 'pgNumType')[0], 'start')).toBe('1')
    // Later sections link to the previous header and continue the numbering.
    for (const s of rest) {
      expect(wAll(s, 'headerReference')).toHaveLength(0)
      expect(wAttr(wAll(s, 'pgNumType')[0], 'start') ?? null).toBeNull()
      expect(wAttr(wAll(s, 'type')[0], 'val') ?? 'nextPage').toBe('nextPage')
    }
    for (const s of sects) {
      expect(wAttr(wAll(s, 'pgSz')[0], 'w')).toBe('12240')
      expect(wAttr(wAll(s, 'pgSz')[0], 'h')).toBe('15840')
      const m = wAll(s, 'pgMar')[0]
      for (const side of ['top', 'right', 'bottom', 'left']) expect(wAttr(m, side), side).toBe('1440')
      expect(wAttr(m, 'header')).toBe('720')
    }
  })

  it('the header is "Surname / Title / PAGE" flush right, with a real PAGE field', async () => {
    const { files, styles } = await render()
    const header = parseXml(files['word/header1.xml'])
    const p = wAll(header, 'p')[0]
    expect(pStyle(p)).toBe('Header')
    expect(pText(p)).toBe('Slaughter / The Long Night / ')
    expect(wAll(p, 'instrText').map((e) => e.textContent?.trim())).toEqual(['PAGE'])
    expect(wAll(p, 'fldChar').map((e) => wAttr(e, 'fldCharType'))).toEqual(['begin', 'separate', 'end'])
    expect(wAttr(wAll(styleById(styles, 'Header'), 'jc')[0], 'val')).toBe('right')
  })

  it('upper-case title, other orders and the trimmed short title', async () => {
    const upper = await render(testSettings({ header: { format: 'title-surname-page', titleCase: 'upper', startPage: 2, shortTitle: '  Night  ' } }))
    expect(pText(wAll(parseXml(upper.files['word/header1.xml']), 'p')[0])).toBe('NIGHT / Slaughter / ')
    const pageOnly = await render(testSettings({ header: { format: 'page', titleCase: 'as-typed', startPage: 2, shortTitle: '' } }))
    expect(pText(wAll(parseXml(pageOnly.files['word/header1.xml']), 'p')[0])).toBe('')
  })

  it('no running header: the text section names an empty header', async () => {
    const { files } = await render(testSettings({ header: { format: 'none', titleCase: 'as-typed', startPage: 2, shortTitle: '' } }))
    const header = parseXml(files['word/header1.xml'])
    expect(wAll(header, 'instrText')).toHaveLength(0)
    expect(pText(wAll(header, 'p')[0])).toBe('')
  })

  it('startPage 1: the title page has the header and is page 1; the text continues', async () => {
    const { document } = await render(testSettings({ header: { format: 'surname-title-page', titleCase: 'as-typed', startPage: 1, shortTitle: '' } }))
    const [title, text] = wAll(document, 'sectPr')
    expect(wAll(title, 'headerReference')).toHaveLength(1)
    expect(wAttr(wAll(title, 'pgNumType')[0], 'start')).toBe('1')
    expect(wAttr(wAll(text, 'pgNumType')[0], 'start') ?? null).toBeNull()
  })

  it('every chapter and part title opens a new section (so Word keeps the drop at the top of the page)', async () => {
    const { paragraphs } = await render()
    paragraphs.forEach((p, i) => {
      if (pStyle(p) === 'Heading1' || pStyle(p) === 'PartTitle') expect(wAll(paragraphs[i - 1], 'sectPr'), pText(p)).toHaveLength(1)
    })
  })

  it('without a title page the text starts the document, numbered from 1', async () => {
    const { document, paragraphs } = await render(testSettings({ titlePage: { ...testSettings().titlePage, include: false } }))
    expect(wAll(document, 'sectPr')).toHaveLength(6)
    expect(wAll(wAll(document, 'sectPr')[0], 'headerReference')).toHaveLength(1)
    expect(wAttr(wAll(document, 'pgNumType')[0], 'start')).toBe('1')
    expect(paragraphs.some((p) => pStyle(p).startsWith('TitlePage'))).toBe(false)
  })

  it('A4 paper and other margins', async () => {
    const { document } = await render(testSettings({ paper: 'a4', margins: { top: 1.18, right: 1.18, bottom: 1.18, left: 1.18 } }))
    const s = wAll(document, 'sectPr')[1]
    expect(wAttr(wAll(s, 'pgSz')[0], 'w')).toBe('11906')
    expect(wAttr(wAll(s, 'pgSz')[0], 'h')).toBe('16838')
    expect(wAttr(wAll(s, 'pgMar')[0], 'left')).toBe('1699')
  })
})

describe('title page', () => {
  it('contact block upper left with the word count on its first line, title, by-line', async () => {
    const { titlePage } = await render()
    expect(titlePage.map(pStyle)).toEqual(['TitlePageContact', 'TitlePageContact', 'TitlePageContact', 'TitlePageContact', 'TitlePageContact', 'TitlePageTitle', 'TitlePageByline'])
    expect(titlePage.map(pText)).toEqual([
      'Ann Example\tabout 100 words',
      '1 Main Street',
      'Springfield, IL 62701',
      '555-0100',
      'ann@example.com',
      'The Long Night',
      'A Novel by Perry Slaughter',
    ])
  })

  it('the word count is the given count, rounded by the rule', async () => {
    const { titlePage } = await render(testSettings({ wordCountRounding: 'auto' }, { wordCount: 79_874 }))
    expect(pText(titlePage[0])).toBe('Ann Example\tabout 80,000 words')
    const exact = await render(testSettings({ wordCountRounding: 'exact' }, { wordCount: 82_260 }))
    expect(pText(exact.titlePage[0])).toBe('Ann Example\t82,260 words')
  })

  it('agent line, no contact, no word count, by-line styles', async () => {
    const tp = testSettings().titlePage
    const agent = await render(testSettings({ titlePage: { ...tp, showAgent: true } }))
    expect(agent.titlePage.map(pText)).toContain('Jo Agent, Example Agency')
    const bare = await render(testSettings({ titlePage: { ...tp, showContact: false, showWordCount: false, bylineStyle: 'by' } }))
    expect(bare.titlePage.map(pText)).toEqual(['The Long Night', 'by Perry Slaughter'])
    const nameOnly = await render(testSettings({ titlePage: { ...tp, showContact: false, bylineStyle: 'name-only' } }))
    expect(nameOnly.titlePage.map(pText)).toEqual(['\tabout 100 words', 'The Long Night', 'Perry Slaughter'])
  })

  it('the title sits one third of the text area below the top margin; the by-line a blank double line below', async () => {
    const { styles } = await render()
    // Text area 9 in = 12960 twips; a third is 4320; five single lines (13.80 pt = 276 twips) of contact block above.
    const title = styleById(styles, 'TitlePageTitle')
    expect(wAttr(wAll(title, 'spacing')[0], 'before')).toBe(String(4320 - 5 * 276))
    expect(wAttr(wAll(title, 'jc')[0], 'val')).toBe('center')
    expect(wAttr(wAll(styleById(styles, 'TitlePageByline'), 'spacing')[0], 'before')).toBe('552')
    // The word count's right tab at the right margin.
    const tab = wAll(styleById(styles, 'TitlePageContact'), 'tab')[0]
    expect([wAttr(tab, 'val'), wAttr(tab, 'pos')]).toEqual(['right', '9360'])
    expect(wAttr(wAll(styleById(styles, 'TitlePageContact'), 'spacing')[0], 'line')).toBe('240')
  })
})

describe('styles', () => {
  it('Normal: the font, size, exact double spacing (480 / auto), 0.5 in first-line indent, widow control, ragged right', async () => {
    const { styles } = await render()
    const normal = styleById(styles, 'Normal')
    const spacing = wAll(normal, 'spacing')[0]
    expect([wAttr(spacing, 'line'), wAttr(spacing, 'lineRule'), wAttr(spacing, 'before'), wAttr(spacing, 'after')]).toEqual(['480', 'auto', '0', '0'])
    expect(wAttr(wAll(normal, 'ind')[0], 'firstLine')).toBe('720')
    expect(wAll(normal, 'widowControl')).toHaveLength(1)
    expect(wAttr(wAll(normal, 'jc')[0], 'val')).toBe('left')
    expect(wAttr(wAll(normal, 'rFonts')[0], 'ascii')).toBe('Times New Roman')
    expect(wAttr(wAll(normal, 'sz')[0], 'val')).toBe('24')
  })

  it('no hyphenation', async () => {
    const { files } = await render()
    const settings = parseXml(files['word/settings.xml'])
    expect(wAttr(wAll(settings, 'autoHyphenation')[0], 'val')).toBe('false')
  })

  it('1.5 and single spacing', async () => {
    expect(wAttr(wAll(styleById((await render(testSettings({ lineSpacing: 1.5 }))).styles, 'Normal'), 'spacing')[0], 'line')).toBe('360')
    expect(wAttr(wAll(styleById((await render(testSettings({ lineSpacing: 1 }))).styles, 'Normal'), 'spacing')[0], 'line')).toBe('240')
  })

  it('Heading 1 (chapters): page break before, dropped a third of the text area, centred, outline level 0, not bold', async () => {
    const { styles } = await render()
    const h1 = styleById(styles, 'Heading1')
    expect(wAttr(wAll(h1, 'name')[0], 'val')).toBe('heading 1')
    expect(wAll(h1, 'pageBreakBefore')).toHaveLength(1)
    expect(wAttr(wAll(h1, 'spacing')[0], 'before')).toBe('4320')
    expect(wAttr(wAll(h1, 'spacing')[0], 'after')).toBe('552')
    expect(wAttr(wAll(h1, 'jc')[0], 'val')).toBe('center')
    expect(wAttr(wAll(h1, 'outlineLvl')[0], 'val')).toBe('0')
    expect(wAttr(wAll(h1, 'ind')[0], 'firstLine')).toBe('0')
    expect(wAttr(wAll(h1, 'b')[0], 'val')).toBe('false')
  })

  it('the chapter drop follows chapterDropFraction', async () => {
    const { styles } = await render(testSettings({ chapterDropFraction: 0.5 }))
    expect(wAttr(wAll(styleById(styles, 'Heading1'), 'spacing')[0], 'before')).toBe('6480')
  })

  it('First Paragraph is indented like any other by default, flush with indentFirstParagraph off', async () => {
    expect(wAttr(wAll(styleById((await render()).styles, 'FirstParagraph'), 'ind')[0], 'firstLine')).toBe('720')
    expect(wAttr(wAll(styleById((await render(testSettings({ indentFirstParagraph: false }))).styles, 'FirstParagraph'), 'ind')[0], 'firstLine')).toBe('0')
  })

  it('trims the font family at use', async () => {
    const { styles } = await render(testSettings({ fontFamily: '  Courier New  ' }))
    expect(wAttr(wAll(styleById(styles, 'Normal'), 'rFonts')[0], 'ascii')).toBe('Courier New')
  })

  it('every paragraph names a style or is Normal, and none carries a direct indent but nested list items', async () => {
    const { paragraphs, styles } = await render()
    const ids = new Set(wAll(styles, 'style').map((s) => wAttr(s, 'styleId')))
    for (const p of paragraphs) {
      const id = pStyle(p)
      if (id) expect(ids.has(id), id).toBe(true)
      if (wAll(p, 'ind').length) expect(id).toBe('ListParagraph')
      // No indenting with tabs or spaces.
      expect(pText(p)).not.toMatch(/^[ \t]+\S/)
    }
  })
})

describe('the text', () => {
  it('chapters are Heading 1 paragraphs: number and title on separate lines, no direct page break', async () => {
    const { text } = await render()
    const headings = text.filter((p) => pStyle(p) === 'Heading1')
    expect(headings.map(pText)).toEqual(['Chapter One\nThe Arrival', 'The Storm', '', 'Epilogue'])
    for (const h of headings) expect(wAll(h, 'pageBreakBefore')).toHaveLength(0)
  })

  it('front matter comes first, on the first text page', async () => {
    const { text } = await render()
    expect(text.slice(0, 4).map((p) => [pStyle(p), pText(p)])).toEqual([
      ['Centered', 'THE LONG NIGHT'],
      ['Centered', 'A novel'],
      ['Dedication', 'For M.'],
      ['Epigraph', 'Not all who wander are lost.'],
    ])
    // The recto section break before the dedication starts a page.
    expect(wAll(text[2], 'pageBreakBefore')).toHaveLength(1)
  })

  it('roles map to their styles', async () => {
    const { text } = await render()
    const styleOf = (t: string) => pStyle(text.find((p) => pText(p).includes(t))!)
    expect(styleOf('It was night')).toBe('FirstParagraph')
    expect(styleOf('She waited.')).toBe('')
    expect(styleOf('Dear Ann')).toBe('BlockQuote')
    expect(styleOf('At the Harbour')).toBe('Heading2')
    expect(styleOf('end of part one')).toBe('FlushRight')
    expect(styleOf('Part Two')).toBe('PartTitle')
    expect(styleOf('Bread')).toBe('ListParagraph')
  })

  it('scene breaks are centred "#" paragraphs (the settings marker, trimmed)', async () => {
    const plain = await render()
    expect(plain.text.filter((p) => pStyle(p) === 'SceneBreak').map(pText)).toEqual(['#', '#', '#', '#'])
    const stars = await render(testSettings({ sceneBreak: '  * * *  ' }))
    expect(stars.text.filter((p) => pStyle(p) === 'SceneBreak').map(pText)).toEqual(['* * *', '* * *', '* * *', '* * *'])
    expect(wAttr(wAll(styleById(plain.styles, 'SceneBreak'), 'jc')[0], 'val')).toBe('center')
  })

  it('a manual page break starts the next paragraph on a new page (no empty paragraph)', async () => {
    const { text } = await render()
    const p = text.find((x) => pText(x).startsWith('The tide turned.'))!
    expect(wAll(p, 'pageBreakBefore')).toHaveLength(1)
    expect(text.some((x) => pText(x) === '' && pStyle(x) === '')).toBe(false)
  })

  it('line breaks, list markers and nested list indents', async () => {
    const { text } = await render()
    expect(text.map(pText)).toContain('She waited.\nNobody came.')
    expect(text.filter((p) => pStyle(p) === 'ListParagraph').map(pText)).toEqual(['•\tBread', '•\tSalt', '3.\tPinch', '4.\tDash'])
    const pinch = text.find((p) => pText(p).endsWith('Pinch'))!
    expect(wAttr(wAll(pinch, 'ind')[0], 'left')).toBe('1440')
  })

  it('italics stay italic (Standard)', async () => {
    const { text } = await render()
    const p = text.find((x) => pText(x).startsWith('It was night'))!
    const runs = wAll(p, 'r')
    const cold = runs.find((r) => pText(r) === 'cold')!
    expect(wAll(cold, 'i')).toHaveLength(1)
    expect(wAll(cold, 'u')).toHaveLength(0)
    expect(wAll(runs.find((r) => pText(r) === 'night')!, 'b')).toHaveLength(1)
    expect(wAttr(wAll(runs.find((r) => pText(r) === 'hard')!, 'u')[0], 'val')).toBe('single')
  })

  it('Classic: italics become underline, two spaces after a sentence', async () => {
    const { text, files } = await render(testSettings({ preset: 'classic', italics: 'underline', sentenceSpacing: 2, fontFamily: 'Courier New' }))
    expect(files['word/document.xml']).not.toContain('<w:i/>')
    const p = text.find((x) => pText(x).startsWith('It was night'))!
    const cold = wAll(p, 'r').find((r) => pText(r) === 'cold')!
    expect(wAttr(wAll(cold, 'u')[0], 'val')).toBe('single')
    expect(pText(p)).toBe('It was night.  The rain fell hard and cold.')
  })

  it('the end marker comes last', async () => {
    const { text } = await render(testSettings({ endMarker: 'the-end' }))
    const last = text[text.length - 1]
    expect([pStyle(last), pText(last)]).toEqual(['EndMarker', 'THE END'])
    const none = await render()
    expect(none.text.some((p) => pStyle(p) === 'EndMarker')).toBe(false)
  })
})

describe('footnotes', () => {
  it('are real Word footnotes, referenced from the text', async () => {
    const { files, document } = await render()
    const notes = parseXml(files['word/footnotes.xml'])
    const real = wAll(notes, 'footnote').filter((f) => !wAttr(f, 'type'))
    expect(real.map((f) => wAttr(f, 'id'))).toEqual(['1', '2'])
    expect(real.map((f) => pText(wAll(f, 'p')[0]))).toEqual([' First told in 1902.', ' Second note.']) // a no-break space after Word's number mark
    expect(wAll(real[0], 'footnoteRef')).toHaveLength(1)
    expect(pStyle(wAll(real[0], 'p')[0])).toBe('FootnoteText')
    expect(wAll(document, 'footnoteReference').map((r) => wAttr(r, 'id'))).toEqual(['1', '2'])
  })

  it('footnote text: body font size, single-spaced, no indent', async () => {
    const { styles } = await render()
    const s = styleById(styles, 'FootnoteText')
    expect(wAttr(wAll(s, 'sz')[0], 'val')).toBe('24')
    expect(wAttr(wAll(s, 'spacing')[0], 'line')).toBe('240')
    expect(wAttr(wAll(s, 'ind')[0], 'firstLine')).toBe('0')
  })
})

describe('user text is escaped safely', () => {
  const nasty = 'Fish & <chips> "quoted" \'single\' ]]> \u0001\u0008\u000B\u001F￾ bell 😀 👩‍👩‍👧 \uD800lone'
  const ir = tinyIR({
    frontMatter: [{ kind: 'paragraph', role: 'body', runs: [{ kind: 'text', text: nasty }] }],
    footnotes: [{ index: 0, number: 1, label: '1', chapter: 0, runs: [{ kind: 'text', text: '<note> & \u0002' }] }],
  })
  ir.chapters[0].blocks.push({ kind: 'paragraph', role: 'body', runs: [{ kind: 'text', text: 'tab\there' }, { kind: 'footnoteRef', footnote: 0 }] })

  it('XML specials, control characters, lone surrogates and emoji', async () => {
    const settings = testSettings({ sceneBreak: '<#>' }, { title: 'A & B <C> "D"\u0007', contact: { ...testSettings().info.contact, legalName: 'Ann & <Co>' } })
    const { files, text, titlePage } = await render(settings, ir)
    for (const [path, xml] of Object.entries(files)) if (path.endsWith('.xml')) parseXml(xml)
    expect(pText(text[0])).toBe('Fish & <chips> "quoted" \'single\' ]]>  bell 😀 👩‍👩‍👧 lone')
    expect(text.map(pText)).toContain('tab\there')
    expect(titlePage.map(pText)).toContain('A & B <C> "D"')
    expect(pText(titlePage[0])).toBe('Ann & <Co>\tabout 0 words') // a dozen words round to 0 (nearest 100)
    expect(parseXml(files['docProps/core.xml']).getElementsByTagName('dc:title')[0].textContent).toBe('A & B <C> "D"')
    expect(pText(wAll(parseXml(files['word/footnotes.xml']), 'footnote').filter((f) => !wAttr(f, 'type'))[0])).toBe(' <note> & ')
  })
})

describe('inputs', () => {
  it('does not mutate the IR or the settings', async () => {
    const ir = structuredClone(FIXTURE_MANUSCRIPT_IR)
    const settings = testSettings({ fontFamily: ' Times New Roman ', sceneBreak: ' # ' })
    const before = structuredClone({ ir, settings })
    await renderDocx(ir, settings)
    expect({ ir, settings }).toEqual(before)
  })

  it('an empty manuscript is still a valid document', async () => {
    const { files } = await render(testSettings(), { ...tinyIR(), chapters: [] })
    parseXml(files['word/document.xml'])
  })
})
