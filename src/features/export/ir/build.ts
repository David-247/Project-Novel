import { getSchema } from '@tiptap/core'
import type { Mark, Node as PMNode, Schema } from '@tiptap/pm/model'
import { EditorState } from '@tiptap/pm/state'
import { COMMENT_MARK } from '@/features/comments'
import { blockPlainText, createEditorExtensions, defaultStyleIdFor, effectiveStyleId, FOOTNOTE_NODE, getChapters } from '@/features/editor'
import { acceptAll, listChanges } from '@/features/track-changes'
import {
  chapterRoles,
  continuesHeadingGroup,
  footnoteLabel,
  resolveFootnoteOptions,
  resolveStyleSheet,
  STYLE_IDS,
  type ChapterRole,
  type FootnoteOptions,
  type FootnoteSettings,
  type ResolvedStyle,
  type ResolvedStyles,
  type StyleSheetJSON,
} from '@/shared/book'
import type { DocJSON } from '@/shared/document'
import { REWRITE_BLOCK_ATTR } from '@/shared/rewrite'
import {
  EMPHASIS_KEYS,
  MANUSCRIPT_IR_VERSION,
  type Emphasis,
  type InlineRun,
  type ListInfo,
  type ManuscriptBlock,
  type ManuscriptChapter,
  type ManuscriptFootnote,
  type ManuscriptIR,
  type ManuscriptReport,
  type NoteRun,
  type ParagraphBlock,
  type ParagraphRole,
  type SceneBreakBlock,
} from './types'

export interface BuildManuscriptOptions {
  /** `book.footnotes` (numbering scope and format). Default: numbered through the book, arabic. */
  footnotes?: FootnoteSettings
  /**
   * Anchors (`RewriteRecord.anchor`) of the open re-writes (store `rewrite`). Default: every re-write
   * anchor found in the document counts as open (resolved re-writes drop their anchors).
   */
  openRewriteAnchors?: Iterable<string>
  /** Schema for a JSON `doc`. Default: the editor's schema. */
  schema?: Schema
  /**
   * Empty paragraphs between two prose paragraphs of a chapter: `'auto'` (default) reads them as a
   * scene break, unless blanks separate most paragraphs (spacing: `report.blankLineSpacing`); `'off'`
   * always leaves them out.
   */
  blankLineSceneBreaks?: 'auto' | 'off'
}

let editorSchema: Schema | null = null
const defaultSchema = () => (editorSchema ??= getSchema(createEditorExtensions({ detached: true })))

const isNode = (d: PMNode | DocJSON): d is PMNode => typeof (d as PMNode).nodeSize === 'number'
const isResolved = (s: ResolvedStyles | StyleSheetJSON): s is ResolvedStyles => s instanceof Map

/**
 * Builds the manuscript IR (./types.ts, docs/manuscript-ir.md) from a document: a ProseMirror node, or
 * its JSON (as manuscript.json holds it; for a worker). `styles`: the book's style sheet, resolved
 * (`getResolvedStyles()`) or as stored (`book.styles`). Pure: reads neither the store nor the DOM, and
 * never changes its input. O(document).
 *
 * 1. Pending tracked changes are resolved as accepted (the track-changes slice's `acceptAll`: inline
 *    changes, then joins, splits, breaks and style changes), so the text is what No Markup shows.
 * 2. The accepted document is cut into front matter and chapters (`getChapters`), and each block is
 *    given its role, runs and breaks.
 */
export function buildManuscript(doc: PMNode | DocJSON, styles: ResolvedStyles | StyleSheetJSON = {}, options: BuildManuscriptOptions = {}): ManuscriptIR {
  const source = isNode(doc) ? doc : (options.schema ?? defaultSchema()).nodeFromJSON(doc)
  const resolved = isResolved(styles) ? styles : resolveStyleSheet(styles)
  const report = emptyReport()
  countReviewItems(source, report, options.openRewriteAnchors)
  const accepted = acceptAll(EditorState.create({ doc: source }))?.doc ?? source
  return new Builder(accepted, resolved, resolveFootnoteOptions(options.footnotes), report, options.blankLineSceneBreaks ?? 'auto').build()
}

function emptyReport(): ManuscriptReport {
  return {
    trackedChanges: { total: 0, insertions: 0, deletions: 0, formatChanges: 0, blockChanges: 0 },
    comments: 0,
    openRewrites: 0,
    manualSceneBreaks: [],
    strippedFormatting: { fontFamily: 0, fontSize: 0, blockLayout: 0 },
    emptyParagraphs: 0,
    blankLineSpacing: false,
    redundantPageBreaks: 0,
  }
}

/** Tracked changes, comments and open re-writes of the document as written (before accepting). */
function countReviewItems(doc: PMNode, report: ManuscriptReport, openAnchors: Iterable<string> | undefined): void {
  const tc = report.trackedChanges
  for (const c of listChanges(doc)) {
    tc.total++
    if (c.kinds.includes('insertion')) tc.insertions++
    if (c.kinds.includes('deletion')) tc.deletions++
    if (c.kinds.includes('formatChange')) tc.formatChanges++
    if (c.kinds.some((k) => k === 'styleChange' || k === 'blockInsert' || k === 'blockDelete')) tc.blockChanges++
  }
  const comments = new Set<string>()
  const anchors = new Set<string>()
  doc.descendants((node) => {
    for (const m of node.marks) if (m.type.name === COMMENT_MARK && typeof m.attrs.id === 'string') comments.add(m.attrs.id)
    const anchor = node.attrs[REWRITE_BLOCK_ATTR]
    if (typeof anchor === 'string' && anchor) anchors.add(anchor)
    return !node.isText
  })
  report.comments = comments.size
  const open = openAnchors ? new Set(openAnchors) : null
  report.openRewrites = open ? [...anchors].filter((a) => open.has(a)).length : anchors.size
}

// ---- inline runs --------------------------------------------------------------------------------

const EMPHASIS_MARKS: ReadonlyMap<string, keyof Emphasis> = new Map(EMPHASIS_KEYS.map((k) => [k, k]))

function emphasisOf(marks: readonly Mark[]): Emphasis {
  const e: Emphasis = {}
  for (const m of marks) {
    const key = EMPHASIS_MARKS.get(m.type.name)
    if (key) e[key] = true
  }
  return e
}

const sameEmphasis = (a: Emphasis, b: Emphasis) => EMPHASIS_KEYS.every((k) => a[k] === b[k])

/** Manual scene breaks: a short paragraph of only "*", "#", "~" or an ornament. */
const MANUAL_SCENE_BREAK = /^(?:[*#~❦⁂✻✱•·]\s*){1,9}$/u

const BULLETS = ['•', '◦', '▪']

/** Blank lines are spacing when at least this many prose pairs exist and most are blank-separated. */
const SPACING_MIN_PAIRS = 8

const isProse = (b: ManuscriptBlock | undefined): b is ParagraphBlock => b?.kind === 'paragraph' && (b.role === 'body' || b.role === 'first')

/** A blank-line scene break, kept or taken out again once the whole document is read. */
interface BlankBreak {
  blocks: ManuscriptBlock[]
  brk: SceneBreakBlock
  next: ParagraphBlock
  /** `next` was 'body' before the break made it 'first'. */
  wasBody: boolean
  blanks: number
}

class Builder {
  private readonly roles: ReadonlyMap<string, ChapterRole>
  private readonly footnotes: ManuscriptFootnote[] = []
  private readonly frontMatter: ManuscriptBlock[] = []
  private readonly chapters: ManuscriptChapter[] = []
  /** Blocks of the chapter (or front matter) being written, and its index. */
  private out: ManuscriptBlock[] = this.frontMatter
  private chapter = -1
  /** The next body paragraph is a first paragraph. */
  private firstPending = true
  /** Empty paragraphs seen since the last block (a blank-line scene break when text follows). */
  private blanks = 0
  /** Since the last heading (chapter title, subheading, part title): only epigraphs, quotes and aligned lines. */
  private headingOpening = false
  /** Rendered style id of the previous top-level block (null for a break or a list), for heading groups. */
  private prevTop: string | null = null
  private readonly blankBreaks: BlankBreak[] = []
  /** Neighbouring prose paragraphs in chapters, and those of them separated by blanks (the spacing guard). */
  private prosePairs = 0
  private blankPairs = 0

  constructor(
    private readonly doc: PMNode,
    private readonly styles: ResolvedStyles,
    private readonly noteOptions: FootnoteOptions,
    private readonly report: ManuscriptReport,
    private readonly blankLines: 'auto' | 'off',
  ) {
    this.roles = chapterRoles(styles)
  }

  build(): ManuscriptIR {
    const starts = getChapters(this.doc, this.styles, 'all').map((c) => c.from)
    let next = 0
    let number: PMNode[] = []
    let prev: string | null = null
    this.doc.forEach((node, offset) => {
      this.prevTop = prev
      prev = node.type.name === 'paragraph' || node.type.name === 'heading' ? (this.styleOf(node)?.id ?? null) : null
      if (next < starts.length && offset === starts[next]) {
        this.endSection()
        next++
        number = []
      }
      const role = this.chapterRoleOf(node)
      // Between a chapter's start and its title: its number block(s) (getChapters' grouping).
      if (role === 'number' && this.chapters.length < next) {
        number.push(node)
        return
      }
      if (role === 'title' && this.chapters.length < next) {
        this.openChapter(next - 1, number, node)
        number = []
        return
      }
      this.block(node)
    })
    this.endSection()
    this.settleBlankBreaks()
    return { version: MANUSCRIPT_IR_VERSION, frontMatter: this.frontMatter, chapters: this.chapters, footnotes: this.footnotes, report: this.report }
  }

  // ---- styles ----

  private styleOf(node: PMNode): ResolvedStyle | undefined {
    const id = effectiveStyleId(node)
    return this.styles.get(this.styles.has(id) ? id : defaultStyleIdFor(node.attrs, node.type.name))
  }

  private chapterRoleOf(node: PMNode): ChapterRole | undefined {
    if (node.type.name !== 'paragraph' && node.type.name !== 'heading') return undefined
    const style = this.styleOf(node)
    return style ? this.roles.get(style.id) : undefined
  }

  /** True when `style` is `target` or based on it. */
  private basedOn(style: ResolvedStyle | undefined, ...targets: string[]): boolean {
    for (let s = style, guard = 0; s && guard < 64; s = s.basedOn ? this.styles.get(s.basedOn) : undefined, guard++) if (targets.includes(s.id)) return true
    return false
  }

  // ---- structure ----

  private openChapter(index: number, numberBlocks: PMNode[], title: PMNode): void {
    // Footnotes in the number block(s) belong to this chapter (the editor's chapter starts there).
    this.chapter = index
    const number: InlineRun[] = []
    for (const [i, b] of numberBlocks.entries()) {
      if (i > 0) number.push({ kind: 'lineBreak' })
      number.push(...this.runs(b))
    }
    const chapter: ManuscriptChapter = {
      index,
      number: mergeRuns(number),
      numberText: numberBlocks.map((b) => blockPlainText(b)).join('\n'),
      title: this.runs(title),
      titleText: blockPlainText(title),
      titleStyleId: this.styleOf(title)?.id ?? STYLE_IDS.chapterTitle,
      blocks: [],
    }
    this.chapters.push(chapter)
    this.out = chapter.blocks
    this.firstPending = true
    this.headingOpening = true
    this.blanks = 0
  }

  /** When blanks separate most prose paragraphs they are spacing: take the blank-line breaks out again. */
  private settleBlankBreaks(): void {
    if (this.prosePairs < SPACING_MIN_PAIRS || this.blankPairs * 2 <= this.prosePairs) return
    this.report.blankLineSpacing = true
    for (const b of this.blankBreaks) {
      b.blocks.splice(b.blocks.indexOf(b.brk), 1)
      if (b.wasBody) b.next.role = 'body'
      this.report.emptyParagraphs += b.blanks
    }
    this.report.manualSceneBreaks = this.report.manualSceneBreaks.filter((m) => m.kind !== 'blank')
  }

  /** The end of the front matter or a chapter: trailing empty paragraphs and page breaks go. */
  private endSection(): void {
    this.report.emptyParagraphs += this.blanks
    this.blanks = 0
    while (this.out.at(-1)?.kind === 'pageBreak') {
      this.out.pop()
      this.report.redundantPageBreaks++
    }
  }

  private emit(block: ManuscriptBlock): void {
    // A blank line is a scene break only between two prose paragraphs of a chapter.
    const prosePair = this.chapter >= 0 && isProse(block) && isProse(this.out.at(-1))
    if (prosePair) {
      this.prosePairs++
      if (this.blanks > 0) this.blankPairs++
    }
    if (this.blanks > 0) {
      if (prosePair && this.blankLines === 'auto') {
        const brk: SceneBreakBlock = { kind: 'sceneBreak', source: 'manual', original: '' }
        this.out.push(brk)
        this.report.manualSceneBreaks.push({ chapter: this.chapter, kind: 'blank', original: '' })
        this.blankBreaks.push({ blocks: this.out, brk, next: block, wasBody: block.role === 'body', blanks: this.blanks })
        this.report.emptyParagraphs += this.blanks - 1
        block.role = 'first'
      } else this.report.emptyParagraphs += this.blanks
      this.blanks = 0
    }
    if (block.kind === 'sectionBreak' && this.out.at(-1)?.kind === 'pageBreak') {
      this.out.pop()
      this.report.redundantPageBreaks++
    }
    this.out.push(block)
  }

  private sceneBreak(source: 'node' | 'manual', original: string): void {
    // A blank line next to a scene break is part of it.
    this.report.emptyParagraphs += this.blanks
    this.blanks = 0
    this.emit({ kind: 'sceneBreak', source, original })
    if (source === 'manual') this.report.manualSceneBreaks.push({ chapter: this.chapter, kind: 'symbol', original })
    this.firstPending = true
    this.headingOpening = false
  }

  // ---- blocks ----

  private block(node: PMNode): void {
    switch (node.type.name) {
      case 'paragraph':
      case 'heading':
        return this.textBlock(node)
      case 'sceneBreak':
        return this.sceneBreak('node', String(node.attrs.ornament ?? ''))
      case 'pageBreak':
        this.report.emptyParagraphs += this.blanks
        this.blanks = 0
        return this.emit({ kind: 'pageBreak' })
      case 'bulletList':
      case 'orderedList':
        return this.list(node, 0)
      default:
        // Unknown block (a newer schema): its textblocks as body text.
        node.descendants((child) => {
          if (child.isTextblock) this.textBlock(child)
          return !child.isTextblock
        })
    }
  }

  private isEmpty(node: PMNode): boolean {
    let empty = true
    node.forEach((child) => {
      if (empty && (child.type.name === FOOTNOTE_NODE || (child.isText ? /\S/.test(child.text ?? '') : child.type.name !== 'hardBreak'))) empty = false
    })
    return empty
  }

  private countBlockLayout(node: PMNode): void {
    const a = node.attrs
    if (a.lineHeight != null || a.paragraphSpacing != null || a.firstLineIndent != null || (typeof a.indent === 'number' && a.indent > 0)) this.report.strippedFormatting.blockLayout++
  }

  private textBlock(node: PMNode): void {
    if (this.isEmpty(node)) {
      this.blanks++
      return
    }
    this.countBlockLayout(node)
    const style = this.styleOf(node)
    const text = node.textContent.trim()
    // A paragraph holding a footnote is never a scene break (the note would be lost).
    if (!this.hasFootnote(node) && (this.basedOn(style, STYLE_IDS.sceneBreak) || MANUAL_SCENE_BREAK.test(text))) return this.sceneBreak('manual', text)

    const level = node.type.name === 'heading' ? Number(node.attrs.level) : 0
    const chapterStyle = style?.kind === 'chapter'
    const outline = chapterStyle ? (style.outlineLevel ?? 1) : level
    // A block continuing a heading group (a breaking style's breaking next style) breaks once, as in the editor.
    const start = style?.breakBefore
    if (style && (start === 'page' || start === 'recto') && !continuesHeadingGroup(this.prevTop, style.id, this.styles)) this.emit({ kind: 'sectionBreak', start })

    let role: ParagraphRole
    if ((chapterStyle && outline >= 2) || (!chapterStyle && level >= 2)) role = 'subheading'
    else if (chapterStyle || level === 1) role = 'partTitle'
    else if (this.basedOn(style, STYLE_IDS.blockQuote, STYLE_IDS.epigraph)) role = 'blockQuote'
    else role = 'body'

    const variant = this.basedOn(style, STYLE_IDS.epigraph) ? 'epigraph' : this.basedOn(style, STYLE_IDS.dedication) ? 'dedication' : undefined
    let runs = this.runs(node)
    // An epigraph style's italic is emphasis, not book styling.
    if (variant === 'epigraph' && style?.italic) runs = mergeRuns(runs.map((r) => (r.kind === 'text' ? { ...r, italic: true } : r)))
    const block: ParagraphBlock = { kind: 'paragraph', role, ...(style ? { styleId: style.id } : {}), ...(variant ? { variant } : {}), runs }
    const align = this.alignOf(node, style)
    if (role === 'body' && align) {
      block.role = 'aligned'
      block.align = align
    } else if (role === 'body' && (this.firstPending || this.basedOn(style, STYLE_IDS.firstParagraph))) block.role = 'first'
    this.emit(block)
    const heading = role === 'subheading' || role === 'partTitle'
    // Right after a heading, an epigraph, quote or aligned line keeps the next prose paragraph first.
    const keep = this.headingOpening && this.firstPending && (block.role === 'blockQuote' || block.role === 'aligned')
    this.firstPending = heading || keep
    this.headingOpening = heading || keep
  }

  private alignOf(node: PMNode, style: ResolvedStyle | undefined): 'center' | 'right' | undefined {
    const direct = node.attrs.textAlign
    const align = typeof direct === 'string' && direct ? direct : style?.align
    return align === 'center' || align === 'right' ? align : undefined
  }

  private hasFootnote(node: PMNode): boolean {
    let found = false
    node.forEach((c) => {
      if (c.type.name === FOOTNOTE_NODE) found = true
    })
    return found
  }

  private list(list: PMNode, depth: number): void {
    const ordered = list.type.name === 'orderedList'
    const start = typeof list.attrs.start === 'number' ? list.attrs.start : 1
    this.report.emptyParagraphs += this.blanks
    this.blanks = 0
    list.forEach((item, _o, i) => {
      let marked = false
      item.forEach((child) => {
        if (child.type.name === 'bulletList' || child.type.name === 'orderedList') return this.list(child, depth + 1)
        if (!child.isTextblock) return
        if (this.isEmpty(child)) {
          this.report.emptyParagraphs++
          return
        }
        this.countBlockLayout(child)
        const info: ListInfo = { marker: marked ? '' : ordered ? `${start + i}.` : BULLETS[Math.min(depth, BULLETS.length - 1)], depth, ordered }
        marked = true
        const styleId = this.styleOf(child)?.id
        this.emit({ kind: 'paragraph', role: 'listItem', ...(styleId ? { styleId } : {}), list: info, runs: this.runs(child) })
      })
    })
    this.firstPending = false
    this.headingOpening = false
  }

  // ---- runs ----

  private runs(block: PMNode): InlineRun[] {
    const runs: InlineRun[] = []
    block.forEach((child) => {
      if (child.type.name === FOOTNOTE_NODE) runs.push({ kind: 'footnoteRef', footnote: this.footnote(child) })
      else this.inline(child, runs)
    })
    return mergeRuns(runs)
  }

  private inline(node: PMNode, runs: InlineRun[] | NoteRun[]): void {
    if (node.isText) {
      for (const m of node.marks) {
        if (m.type.name !== 'textStyle') continue
        if (m.attrs.fontFamily) this.report.strippedFormatting.fontFamily++
        if (m.attrs.fontSize) this.report.strippedFormatting.fontSize++
      }
      ;(runs as InlineRun[]).push({ kind: 'text', text: node.text ?? '', ...emphasisOf(node.marks) })
    } else if (node.type.name === 'hardBreak') (runs as InlineRun[]).push({ kind: 'lineBreak' })
    else {
      const leafText = node.type.spec.leafText
      if (leafText) (runs as InlineRun[]).push({ kind: 'text', text: leafText(node), ...emphasisOf(node.marks) })
    }
  }

  private footnote(node: PMNode): number {
    const index = this.footnotes.length
    const prev = this.footnotes.at(-1)
    const restart = this.noteOptions.numbering === 'chapter' && (!prev || prev.chapter !== this.chapter)
    const number = restart || !prev ? 1 : prev.number + 1
    const runs: NoteRun[] = []
    node.forEach((child) => this.inline(child, runs))
    this.footnotes.push({ index, number, label: footnoteLabel(number, this.noteOptions.format), chapter: this.chapter, runs: mergeRuns(runs) as NoteRun[] })
    return index
  }
}

/** Joins neighbouring text runs of the same emphasis; drops empty ones. */
function mergeRuns(runs: InlineRun[]): InlineRun[] {
  const out: InlineRun[] = []
  for (const r of runs) {
    if (r.kind === 'text') {
      if (!r.text) continue
      const last = out.at(-1)
      if (last?.kind === 'text' && sameEmphasis(last, r)) {
        out[out.length - 1] = { ...last, text: last.text + r.text }
        continue
      }
    }
    out.push(r)
  }
  return out
}
