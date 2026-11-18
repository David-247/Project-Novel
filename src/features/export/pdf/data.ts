import type { ExportFontRole } from '../platform'
import type { InlineRun, ManuscriptBlock, ManuscriptIR, NoteRun, ParagraphBlock } from '../ir'
import { assertManuscriptVersion } from '../ir'
import {
  bylineName,
  formatWordCount,
  surnameOf,
  type ContactDetails,
  type HeaderSettings,
  type ManuscriptSettings,
} from '../settings'
import { fontRoleOf, lineMetrics } from './metrics'
import { manuscriptWordCount } from './word-count'

/**
 * The data file (data.json) the bundled Typst template `manuscript.typ` reads
 * (src-tauri/templates/manuscript.typ). Everything the template needs is enumerated here: lengths
 * in pt, every string already final (trimmed, emphasis mapped, sentence spacing applied). The
 * template only places it; manuscript text is always a JSON string shown as text, never Typst
 * markup, so "#", "$", "[" ... in the manuscript print as typed.
 *
 * Bump `PDF_DATA_VERSION` with any change the template must follow.
 */
export const PDF_DATA_VERSION = 1

/** The bundled template id (src-tauri/src/export/templates.rs). */
export const PDF_TEMPLATE_ID = 'manuscript'

/** A text run: `s` with its emphasis flags (only present when set). */
export interface PdfTextRun {
  s: string
  b?: true
  i?: true
  u?: true
  sc?: true
  sup?: true
  sub?: true
}
export interface PdfBreakRun {
  br: true
}
/** A footnote: its number as printed and its text, at the reference. */
export interface PdfNoteRun {
  fn: (PdfTextRun | PdfBreakRun)[]
  n: string
}
export type PdfRun = PdfTextRun | PdfBreakRun | PdfNoteRun

export type PdfAlign = 'left' | 'center' | 'right'

export type PdfBlock =
  /** A paragraph. `indent`: first-line indent on; `pad`: left / right inset (block quotes, lists), pt. */
  | { t: 'p'; align: PdfAlign; indent: boolean; pad: [number, number]; runs: PdfRun[] }
  /** A list item paragraph: `marker` hangs in a box of `hang` pt at `pad` pt from the left margin. */
  | { t: 'li'; marker: string; pad: number; hang: number; runs: PdfRun[] }
  /** A heading set on a new page, dropped (chapter opening, part title): centred lines, then a blank line. */
  | { t: 'opening'; lines: PdfRun[][] }
  /** A subheading: a centred line. */
  | { t: 'sub'; runs: PdfRun[] }
  /** A scene break: the marker centred on its own line. */
  | { t: 'scene'; text: string }
  /** A page break (manual, or a style that starts a page). */
  | { t: 'page' }

export interface PdfTitlePage {
  /** Contact block lines, upper left, single-spaced. */
  contact: string[]
  /** Upper right, e.g. "about 80,000 words"; '' for none. */
  wordCount: string
  title: string
  /** "A Novel by Perry Slaughter"; '' for none. */
  byline: string
  /** Distance from the top margin to the title's line box, pt. */
  drop: number
}

export interface PdfData {
  version: typeof PDF_DATA_VERSION
  document: { title: string; author: string; lang: string }
  page: { paper: 'us-letter' | 'a4'; margin: { top: number; right: number; bottom: number; left: number } }
  type: {
    size: number
    topEdge: number
    bottomEdge: number
    pitch: number
    leading: number
    singleLeading: number
    indent: number
  }
  header: {
    show: boolean
    /** Text before the page number: "Slaughter / Silvertide / " ('' with format "page"). */
    prefix: string
    /** First physical page (counting the title page) that carries the header. */
    from: number
    /** Printed number = physical page - offset. */
    offset: number
    /**
     * Typst `header-ascent`: header line box bottom to the top of the text area, pt. It puts the
     * header's line box 0.5 in below the page's top edge. A top margin under 0.5 in + one line box
     * (about 0.68 in at 12 pt) has no room for that: the ascent is then 0 and the header sits right
     * above the text area, closer to the edge (documented limit; the settings allow 0 to 4 in).
     */
    ascent: number
  }
  titlePage: PdfTitlePage | null
  /** Drop of a chapter opening below the top margin, pt. */
  chapterDrop: number
  blocks: PdfBlock[]
  /** Centred after the last line ('' for none). */
  endMarker: string
}

/** What the export knows besides the IR and the settings. */
export interface ManuscriptMeta {
  /** The manuscript title (the project title). */
  title: string
  /** The resolved contact details (app author profile + the project's override). */
  contact: ContactDetails
  /** Body word count for the title page; default: counted from the IR (`manuscriptWordCount`). */
  wordCount?: number
  /** BCP 47 language of the text (PDF metadata, hyphenation data is never used); default 'en'. */
  language?: string
}

const PT_PER_IN = 72
const PAPER_HEIGHT_PT = { letter: 792, a4: 841.89 } as const
/** Word's default header distance: the header's line box starts 0.5 in below the page's top edge. */
const HEADER_DISTANCE_PT = 36
/** The title on the title page starts a third of the text-area height down (docs/manuscript-format.md). */
const TITLE_DROP_FRACTION = 1 / 3
/** Block quotes are inset this much on both sides; list levels step by it. */
const QUOTE_INSET_PT = 0.5 * PT_PER_IN
const LIST_HANG_PT = 0.25 * PT_PER_IN

const r2 = (n: number) => Math.round(n * 100) / 100

/** The header text before the page number (the page number is always last: settings `runningHeader`). */
export function headerPrefix(h: Pick<HeaderSettings, 'format' | 'titleCase'>, surname: string, shortTitle: string): string {
  const title = h.titleCase === 'upper' ? shortTitle.toUpperCase() : shortTitle
  const parts =
    h.format === 'surname-title-page'
      ? [surname, title]
      : h.format === 'title-surname-page'
        ? [title, surname]
        : h.format === 'surname-page'
          ? [surname]
          : []
  return parts
    .filter((p) => p !== '')
    .map((p) => `${p} / `)
    .join('')
}

const BYLINE: Record<ManuscriptSettings['titlePage']['bylineStyle'], (name: string) => string> = {
  'a-novel-by': (n) => `A Novel by ${n}`,
  by: (n) => `by ${n}`,
  'name-only': (n) => n,
}

/** Lines of a multi-line contact field, each trimmed, empty ones left out. */
const splitLines = (s: string) =>
  s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)

function contactLines(c: ContactDetails, showAgent: boolean): string[] {
  return [
    ...splitLines(c.legalName),
    ...splitLines(c.address),
    ...splitLines(c.phone),
    ...splitLines(c.email),
    ...(showAgent ? splitLines(c.agent) : []),
  ]
}

const SENTENCE_END = /[.!?]["'’”)\]]*$/
const SENTENCE_GAP = /([.!?]["'’”)\]]*) +(?=\S)/g

/**
 * Sentence spacing (docs/manuscript-format.md): the spaces after a sentence's end become `n` spaces.
 * Works across runs ("night" + "." in one run, " It" in the next) within one paragraph.
 */
export function applySentenceSpacing(runs: PdfRun[], n: 1 | 2): PdfRun[] {
  const gap = ' '.repeat(n)
  let endsSentence = false
  return runs.map((r) => {
    if (!('s' in r)) {
      // A footnote reference after a full stop leaves the sentence ended; a line break does not.
      if ('br' in r) endsSentence = false
      return r
    }
    let s = r.s.replace(SENTENCE_GAP, `$1${gap}`)
    if (endsSentence && /^ +\S/.test(s)) s = s.replace(/^ +/, gap)
    // A run of nothing but spaces right after a sentence's end (" " between "night." and "She") is that gap.
    else if (endsSentence && /^ +$/.test(s)) s = gap
    if (/\S/.test(s)) endsSentence = SENTENCE_END.test(s)
    return s === r.s ? r : { ...r, s }
  })
}

interface RunContext {
  ir: ManuscriptIR
  underlineItalics: boolean
  sentenceSpacing: 1 | 2
}

function textRun(r: { text: string } & Partial<Record<'bold' | 'italic' | 'underline' | 'smallCaps' | 'superscript' | 'subscript', true>>, ctx: RunContext): PdfTextRun {
  const out: PdfTextRun = { s: r.text }
  if (r.bold) out.b = true
  if (r.italic && !ctx.underlineItalics) out.i = true
  if (r.underline || (r.italic && ctx.underlineItalics)) out.u = true
  if (r.smallCaps) out.sc = true
  if (r.superscript) out.sup = true
  if (r.subscript) out.sub = true
  return out
}

function noteRuns(runs: readonly NoteRun[], ctx: RunContext): (PdfTextRun | PdfBreakRun)[] {
  const out = runs.map((r): PdfTextRun | PdfBreakRun => (r.kind === 'text' ? textRun(r, ctx) : { br: true }))
  return applySentenceSpacing(out, ctx.sentenceSpacing) as (PdfTextRun | PdfBreakRun)[]
}

function pdfRuns(runs: readonly InlineRun[], ctx: RunContext): PdfRun[] {
  const out: PdfRun[] = []
  for (const r of runs) {
    if (r.kind === 'text') out.push(textRun(r, ctx))
    else if (r.kind === 'lineBreak') out.push({ br: true })
    else {
      const note = ctx.ir.footnotes[r.footnote]
      if (note) out.push({ fn: noteRuns(note.runs, ctx), n: String(note.number) })
    }
  }
  return applySentenceSpacing(out, ctx.sentenceSpacing)
}

function paragraph(b: ParagraphBlock, settings: ManuscriptSettings, ctx: RunContext): PdfBlock {
  const runs = pdfRuns(b.runs, ctx)
  switch (b.role) {
    case 'body':
      return { t: 'p', align: 'left', indent: true, pad: [0, 0], runs }
    case 'first':
      return { t: 'p', align: 'left', indent: settings.indentFirstParagraph, pad: [0, 0], runs }
    case 'blockQuote':
      return { t: 'p', align: b.align ?? 'left', indent: false, pad: [QUOTE_INSET_PT, QUOTE_INSET_PT], runs }
    case 'aligned':
      return { t: 'p', align: b.align ?? 'center', indent: false, pad: [0, 0], runs }
    case 'subheading':
      return { t: 'sub', runs }
    case 'partTitle':
      return { t: 'opening', lines: [runs] }
    case 'listItem': {
      const depth = b.list?.depth ?? 0
      return { t: 'li', marker: b.list?.marker ?? '', pad: r2(QUOTE_INSET_PT + depth * LIST_HANG_PT), hang: LIST_HANG_PT, runs }
    }
  }
}

function blocks(list: readonly ManuscriptBlock[], settings: ManuscriptSettings, scene: string, ctx: RunContext): PdfBlock[] {
  const out: PdfBlock[] = []
  for (const b of list) {
    if (b.kind === 'paragraph') out.push(paragraph(b, settings, ctx))
    else if (b.kind === 'sceneBreak') out.push({ t: 'scene', text: scene })
    // A manuscript has no facing pages: a right-hand (recto) start is a new page like any other.
    else out.push({ t: 'page' })
  }
  return out
}

const END_MARKER: Record<ManuscriptSettings['endMarker'], string> = { none: '', end: 'END', 'the-end': 'THE END' }

/** A language tag Typst accepts (ISO 639 letters), else 'en'. */
function typstLang(tag: string | undefined): string {
  const lang = (tag ?? '').trim().split(/[-_]/)[0].toLowerCase()
  return /^[a-z]{2,3}$/.test(lang) ? lang : 'en'
}

/** The template's data for `ir` with `settings` and `meta`. Pure; `ir`, `settings`, `meta` are not changed. */
export function buildPdfData(ir: ManuscriptIR, settings: ManuscriptSettings, meta: ManuscriptMeta): PdfData {
  assertManuscriptVersion(ir)
  const role: ExportFontRole = fontRoleOf(settings.fontFamily)
  const size = settings.fontSizePt
  const m = lineMetrics(role, size, settings.lineSpacing)
  const margin = {
    top: r2(settings.margins.top * PT_PER_IN),
    right: r2(settings.margins.right * PT_PER_IN),
    bottom: r2(settings.margins.bottom * PT_PER_IN),
    left: r2(settings.margins.left * PT_PER_IN),
  }
  const textHeight = PAPER_HEIGHT_PT[settings.paper] - margin.top - margin.bottom
  const title = meta.title.trim()
  const author = bylineName(meta.contact)
  const ctx: RunContext = { ir, underlineItalics: settings.italics === 'underline', sentenceSpacing: settings.sentenceSpacing }
  const scene = settings.sceneBreak.trim() || '#'

  const tp = settings.titlePage
  const titlePage: PdfTitlePage | null = tp.include
    ? {
        contact: tp.showContact ? contactLines(meta.contact, tp.showAgent) : [],
        wordCount: tp.showWordCount ? formatWordCount(meta.wordCount ?? manuscriptWordCount(ir), settings.wordCountRounding) : '',
        title,
        byline: author ? BYLINE[tp.bylineStyle](author) : '',
        drop: r2(textHeight * TITLE_DROP_FRACTION),
      }
    : null

  const h = settings.header
  const shortTitle = h.shortTitle.trim() || title
  const header = {
    show: h.format !== 'none',
    prefix: headerPrefix(h, surnameOf(author), shortTitle),
    // With a title page: from the first text page, numbered 1 (Shunn); `startPage: 1` puts the
    // header on the title page too, every page then numbered from 1 (decision logged by T6).
    from: titlePage && h.startPage === 2 ? 2 : 1,
    offset: titlePage && h.startPage === 2 ? 1 : 0,
    ascent: r2(Math.max(0, margin.top - HEADER_DISTANCE_PT - m.box)),
  }

  const body: PdfBlock[] = blocks(ir.frontMatter, settings, scene, ctx)
  for (const c of ir.chapters) {
    const headingLines = [pdfRuns(c.number, ctx), pdfRuns(c.title, ctx)].filter((l) => l.length > 0)
    body.push({ t: 'opening', lines: headingLines })
    body.push(...blocks(c.blocks, settings, scene, ctx))
  }

  return {
    version: PDF_DATA_VERSION,
    document: { title, author, lang: typstLang(meta.language) },
    page: { paper: settings.paper === 'a4' ? 'a4' : 'us-letter', margin },
    type: {
      size,
      topEdge: m.topEdgeEm,
      bottomEdge: m.bottomEdgeEm,
      pitch: m.pitch,
      leading: m.leading,
      singleLeading: m.singleLeading,
      indent: r2(settings.firstLineIndentIn * PT_PER_IN),
    },
    header,
    titlePage,
    chapterDrop: r2(textHeight * Math.min(0.5, Math.max(0, settings.chapterDropFraction))),
    blocks: body,
    endMarker: END_MARKER[settings.endMarker],
  }
}
