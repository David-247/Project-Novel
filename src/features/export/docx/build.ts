import {
  Document,
  FootnoteReferenceRun,
  Header,
  Packer,
  PageNumber,
  Paragraph,
  Tab,
  TextRun,
  UnderlineType,
  type IRunOptions,
  type ISectionOptions,
} from 'docx'
// Leaf modules only (not '../ir' or '../settings'): this runs in the export worker, which must not
// load the editor or the app store.
import { assertManuscriptVersion, throwIfAborted, type RenderOptions } from '../ir/renderer'
import type { InlineRun, ManuscriptBlock, ManuscriptIR, NoteRun, ParagraphBlock, TextRun as IRTextRun } from '../ir/types'
import { bylineName, contactBlockLines, formatWordCount, headerShortTitle, manuscriptTitle, runningHeader, sceneBreakText, surnameOf } from '../settings/text'
import { classicSentenceSpacing } from '../settings/sentence-spacing'
import { docxLayout, HEADER_DISTANCE_TWIPS, type DocxLayout } from './layout'
import { manuscriptStyles, STYLE } from './styles'
import { xmlSafe } from './text'
import type { DocxRenderSettings } from './types'

/**
 * The DOCX manuscript generator (docs/manuscript-format.md, docs/docx-export.md): IR + settings ->
 * the bytes of a .docx. Pure apart from the clock (the document's created / modified dates); runs in
 * the export worker (./worker.ts) or, where there is no Worker, in the page (./renderer.ts).
 */

export interface DocxBuildOptions extends RenderOptions {
  /** Created / modified date in the document properties (default: now). Tests pin it. */
  now?: Date
  /**
   * Called between chapters so a render in the page gives the event loop a turn (and a cancel a
   * chance to land). The worker does not need one: it is terminated instead.
   */
  pause?: () => Promise<void>
}

/** Share of the progress bar for building the paragraphs; the rest is writing and zipping the XML. */
const BUILD_SHARE = 0.5

const END_MARKER = { none: '', end: 'END', 'the-end': 'THE END' } as const
const BYLINE = { 'a-novel-by': 'A Novel by ', by: 'by ', 'name-only': '' } as const

interface Ctx {
  settings: DocxRenderSettings
  layout: DocxLayout
}

// ---- runs ------------------------------------------------------------------------------------------

function emphasis(r: IRTextRun, ctx: Ctx): Partial<IRunOptions> {
  const underlineItalics = ctx.settings.italics === 'underline'
  return {
    ...(r.bold ? { bold: true } : {}),
    ...(r.italic && !underlineItalics ? { italics: true } : {}),
    ...(r.underline || (r.italic && underlineItalics) ? { underline: { type: UnderlineType.SINGLE } } : {}),
    ...(r.smallCaps ? { smallCaps: true } : {}),
    ...(r.superscript ? { superScript: true } : {}),
    ...(r.subscript ? { subScript: true } : {}),
  }
}

/** Text as Word runs: tabs become <w:tab/>, stray line feeds <w:br/>; XML-invalid characters go. */
function textRuns(text: string, format: Partial<IRunOptions>): TextRun[] {
  const out: TextRun[] = []
  for (const part of xmlSafe(text).split(/(\t|\r\n|\n|\r)/)) {
    if (part === '') continue
    if (part === '\t') out.push(new TextRun({ ...format, children: [new Tab()] }))
    else if (part === '\n' || part === '\r' || part === '\r\n') out.push(new TextRun({ ...format, break: 1 }))
    else out.push(new TextRun({ ...format, text: part }))
  }
  return out
}

type RunChild = TextRun | FootnoteReferenceRun

function inlineRuns(runs: readonly (InlineRun | NoteRun)[], ctx: Ctx): RunChild[] {
  const out: RunChild[] = []
  // Classic spacing over the paragraph's runs as one text, by the rule the PDF uses too.
  const spaced = ctx.settings.sentenceSpacing === 2 ? classicSentenceSpacing(runs.map((r) => (r.kind === 'text' ? r.text : r.kind === 'lineBreak' ? null : ''))) : null
  runs.forEach((r, i) => {
    if (r.kind === 'text') {
      out.push(...textRuns(spaced?.[i] ?? r.text, emphasis(r, ctx)))
    } else if (r.kind === 'lineBreak') {
      out.push(new TextRun({ break: 1 }))
    } else {
      // Word numbers its footnotes itself (1, 2, 3 ... through the document).
      out.push(new FootnoteReferenceRun(r.footnote + 1))
    }
  })
  return out
}

// ---- blocks ----------------------------------------------------------------------------------------

function paragraphStyle(b: ParagraphBlock): string | undefined {
  switch (b.role) {
    case 'body':
      return undefined // Normal
    case 'first':
      return STYLE.firstParagraph
    case 'blockQuote':
      return b.variant === 'epigraph' ? STYLE.epigraph : STYLE.blockQuote
    case 'subheading':
      return STYLE.subheading
    case 'partTitle':
      return STYLE.partTitle
    case 'aligned':
      if (b.variant === 'dedication') return STYLE.dedication
      return b.align === 'right' ? STYLE.flushRight : STYLE.centered
    case 'listItem':
      return STYLE.listParagraph
  }
}

function paragraph(b: ParagraphBlock, ctx: Ctx, pageBreakBefore: boolean): Paragraph {
  const marker = b.role === 'listItem' && b.list?.marker ? [new TextRun(xmlSafe(b.list.marker)), new TextRun({ children: [new Tab()] })] : []
  const style = paragraphStyle(b)
  return new Paragraph({
    ...(style ? { style } : {}),
    // A nested list item steps in by one indent per level (the style sets level 0).
    ...(b.role === 'listItem' && b.list && b.list.depth > 0
      ? { indent: { left: ctx.layout.firstLineIndent * (b.list.depth + 1), hanging: Math.round(ctx.layout.firstLineIndent / 2) } }
      : {}),
    ...(pageBreakBefore ? { pageBreakBefore: true } : {}),
    children: [...marker, ...inlineRuns(b.runs, ctx)],
  })
}

function sceneBreakMarker(ctx: Ctx): string {
  return xmlSafe(sceneBreakText(ctx.settings)) || '#'
}

/**
 * The text, cut into sections: a chapter or a part title starts a section of its own (next page),
 * which keeps the running header (linked to the previous section) and the page numbering. Word drops
 * a style's space before at the top of a page reached by "page break before", but keeps it after a
 * section break, so this is what puts the heading a third of the way down in Word.
 */
class Body {
  readonly sections: Paragraph[][] = []
  push(p: Paragraph): void {
    if (this.sections.length === 0) this.sections.push([])
    this.sections[this.sections.length - 1].push(p)
  }
  /** `p` opens a new section. */
  newSection(p: Paragraph): void {
    this.sections.push([p])
  }
}

/**
 * Blocks as paragraphs. A page or section break is not a paragraph of its own (an empty paragraph
 * would print a blank line at the top of the next page): the next paragraph starts the page.
 */
function blockParagraphs(blocks: readonly ManuscriptBlock[], ctx: Ctx, out: Body): void {
  let breakPending = false
  for (const b of blocks) {
    if (b.kind === 'pageBreak' || b.kind === 'sectionBreak') {
      // A manuscript is printed one-sided: a recto start is a new page.
      breakPending = true
      continue
    }
    if (b.kind === 'sceneBreak') {
      out.push(new Paragraph({ style: STYLE.sceneBreak, ...(breakPending ? { pageBreakBefore: true } : {}), children: [new TextRun(sceneBreakMarker(ctx))] }))
    } else if (b.role === 'partTitle') {
      // Its style breaks the page and drops it like a chapter heading.
      out.newSection(paragraph(b, ctx, false))
    } else {
      out.push(paragraph(b, ctx, breakPending))
    }
    breakPending = false
  }
}

function chapterHeading(c: ManuscriptIR['chapters'][number], ctx: Ctx): Paragraph {
  const number = inlineRuns(c.number, ctx)
  const title = inlineRuns(c.title, ctx)
  const both = number.length > 0 && title.length > 0
  return new Paragraph({ style: STYLE.chapter, children: [...number, ...(both ? [new TextRun({ break: 1 })] : []), ...title] })
}

// ---- title page and header ----------------------------------------------------------------------

function titlePage(settings: DocxRenderSettings): { paragraphs: Paragraph[]; linesAboveTitle: number } {
  const { info, titlePage: tp } = settings
  const lines = contactBlockLines(info.contact, tp).map(xmlSafe)
  const wordCount = tp.showWordCount ? formatWordCount(info.wordCount, settings.wordCountRounding) : ''
  const paragraphs: Paragraph[] = []
  if (lines.length || wordCount) {
    const [first = '', ...rest] = lines
    paragraphs.push(
      new Paragraph({ style: STYLE.titleContact, children: [new TextRun(first), ...(wordCount ? [new TextRun({ children: [new Tab()] }), new TextRun(wordCount)] : [])] }),
      ...rest.map((l) => new Paragraph({ style: STYLE.titleContact, children: [new TextRun(l)] })),
    )
  }
  const linesAboveTitle = paragraphs.length
  paragraphs.push(new Paragraph({ style: STYLE.titleTitle, children: textRuns(manuscriptTitle(settings.info.title), {}) }))
  const name = bylineName(info.contact)
  if (name) paragraphs.push(new Paragraph({ style: STYLE.titleByline, children: textRuns(BYLINE[tp.bylineStyle] + name, {}) }))
  return { paragraphs, linesAboveTitle }
}

/** A string `runningHeader` cannot produce from a title or a name: where the PAGE field goes. */
const PAGE_SLOT = '\u0000PAGE\u0000'

function header(settings: DocxRenderSettings): Header | null {
  if (settings.header.format === 'none') return null
  const surname = surnameOf(xmlSafe(bylineName(settings.info.contact)))
  const shortTitle = headerShortTitle(settings.header, manuscriptTitle(settings.info.title))
  const text = runningHeader(settings.header, { surname, shortTitle: xmlSafe(shortTitle), page: PAGE_SLOT })
  const [before, after = ''] = text.split(PAGE_SLOT)
  return new Header({
    children: [
      new Paragraph({
        style: STYLE.header,
        // A real PAGE field: Word renumbers the pages itself.
        children: [new TextRun({ children: [xmlSafe(before), PageNumber.CURRENT, ...(after ? [xmlSafe(after)] : [])] })],
      }),
    ],
  })
}

// ---- document properties ----------------------------------------------------------------------

const escapeXml = (s: string) => xmlSafe(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** docProps/core.xml: title, author and language (the `docx` library writes no language). */
function coreProperties(title: string, author: string, language: string, now: Date): string {
  const date = now.toISOString().replace(/\.\d{3}Z$/, 'Z')
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${escapeXml(title)}</dc:title>` +
    `<dc:creator>${escapeXml(author)}</dc:creator>` +
    `<cp:lastModifiedBy>${escapeXml(author)}</cp:lastModifiedBy>` +
    `<dc:language>${escapeXml(language)}</dc:language>` +
    '<cp:revision>1</cp:revision>' +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${date}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${date}</dcterms:modified>` +
    '</cp:coreProperties>'
  )
}

/** A BCP 47 tag as Word writes it (`en-US`); anything else falls back to en-US. */
function languageTag(lang: string | undefined): string {
  const t = (lang ?? '').trim().replace(/_/g, '-')
  return /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(t) ? t : 'en-US'
}

// ---- the document ----------------------------------------------------------------------------------

/**
 * Renders the manuscript as a .docx (the `ManuscriptRenderer` contract: ../ir/renderer.ts): checks the
 * IR version, honours `signal` between chapters and before packing, reports progress (0 -> 1, the
 * paragraphs then the packing). Never mutates `ir` or `settings`.
 */
export async function renderDocx(ir: ManuscriptIR, settings: DocxRenderSettings, options: DocxBuildOptions = {}): Promise<Uint8Array> {
  const { signal, onProgress, pause } = options
  assertManuscriptVersion(ir)
  throwIfAborted(signal)
  const layout = docxLayout(settings)
  const ctx: Ctx = { settings, layout }
  const total = ir.chapters.length + 2 // front matter, chapters, footnotes
  let done = 0
  let last = 0
  const report = (fraction: number, stage: string) => {
    last = Math.max(last, Math.min(1, fraction))
    onProgress?.({ fraction: last, done, total, stage })
  }
  report(0, 'chapters')

  const body = new Body()
  blockParagraphs(ir.frontMatter, ctx, body)
  done++
  for (const c of ir.chapters) {
    if (pause) await pause()
    throwIfAborted(signal)
    body.newSection(chapterHeading(c, ctx))
    blockParagraphs(c.blocks, ctx, body)
    done++
    report((done / total) * BUILD_SHARE, 'chapters')
  }
  const endMarker = END_MARKER[settings.endMarker] ?? ''
  if (endMarker) body.push(new Paragraph({ style: STYLE.endMarker, children: [new TextRun(endMarker)] }))
  if (body.sections.length === 0) body.push(new Paragraph({}))

  const footnotes: Record<string, { children: Paragraph[] }> = {}
  // Word writes the note's number mark first; a no-break space keeps it with the text (as the PDF does).
  for (const f of ir.footnotes) footnotes[String(f.index + 1)] = { children: [new Paragraph({ style: STYLE.footnoteText, children: [new TextRun(' '), ...inlineRuns(f.runs, ctx)] })] }
  done++
  report(BUILD_SHARE, 'footnotes')

  const language = languageTag(settings.info.language)
  const hasTitlePage = settings.titlePage.include
  const tp = hasTitlePage ? titlePage(settings) : null
  const head = header(settings)
  const page = (numberFromOne: boolean) => ({
    size: { width: layout.page.width, height: layout.page.height },
    margin: { ...layout.margins, header: HEADER_DISTANCE_TWIPS, footer: HEADER_DISTANCE_TWIPS, gutter: 0 },
    ...(numberFromOne ? { pageNumbers: { start: 1 } } : {}),
  })
  // Header from the first text page, numbered 1 (startPage 2, Shunn); or on the title page too, with
  // the title page numbered 1 and the text continuing from 2 (startPage 1).
  const headerOnTitlePage = settings.header.startPage === 1
  const sections: ISectionOptions[] = []
  if (tp) {
    sections.push({
      properties: { page: page(true) },
      ...(head && headerOnTitlePage ? { headers: { default: head } } : {}),
      children: tp.paragraphs,
    })
  }
  body.sections.forEach((children, i) => {
    if (i === 0) {
      sections.push({
        properties: { page: page(!tp || !headerOnTitlePage) },
        // Even with no running header the text names an empty one, so it never shows the title page's.
        headers: { default: head ?? new Header({ children: [new Paragraph({ style: STYLE.header })] }) },
        children,
      })
    } else {
      // Later sections name no header (Word links each to the previous one) and continue the numbering.
      sections.push({ properties: { page: page(false) }, children })
    }
  })

  const author = bylineName(settings.info.contact)
  const title = manuscriptTitle(settings.info.title)
  const doc = new Document({
    title,
    creator: author,
    lastModifiedBy: author,
    styles: manuscriptStyles(settings, layout, language, tp?.linesAboveTitle ?? 0),
    footnotes,
    hyphenation: { autoHyphenation: false },
    evenAndOddHeaderAndFooters: false,
    sections,
  })
  throwIfAborted(signal)
  report(BUILD_SHARE, 'pack')
  const core = { path: 'docProps/core.xml', data: coreProperties(title, author, language, options.now ?? new Date()) }
  const bytes = await Packer.pack(doc, 'uint8array', false, [core])
  throwIfAborted(signal)
  done = total
  report(1, 'done')
  return bytes
}
