/**
 * The manuscript IR (intermediate representation): what an export renders (DOCX, PDF; EPUB later).
 * Built from the ProseMirror document by `buildManuscript` (./build.ts); docs/manuscript-ir.md.
 *
 * - Pure, serialisable data (JSON-safe: plain objects, arrays, strings, numbers, booleans): it can
 *   cross a Web Worker boundary and be snapshotted in golden tests.
 * - Semantic only. Book styling (fonts, sizes, colours, highlight, line spacing, indents, trim and paper)
 *   is dropped: the manuscript format replaces it, as publishers expect. What remains is structure
 *   (front matter, chapters, roles), emphasis, breaks, footnotes and list markers.
 * - Final text: pending tracked changes are resolved as accepted (what No Markup shows). Comments,
 *   re-write anchors and review highlights never reach the IR; `report` counts what was resolved or
 *   dropped so the export wizard can tell the user.
 *
 * Renderers (./renderer.ts) treat the IR as read-only and check `version` first.
 */

/**
 * Version of the IR shape. Bump on any change a renderer could misread (a new block kind, a renamed
 * field); adding an optional field that renderers may ignore does not need a bump.
 */
export const MANUSCRIPT_IR_VERSION = 1

// ---- inline runs ----------------------------------------------------------------------------------

/**
 * Emphasis kept from the text. A flag is present (and `true`) only when set, so a plain run is just
 * `{ kind: 'text', text }`. `smallCaps`, `superscript` and `subscript` come from marks of those names
 * when the schema has them (the Phase 4 schema has none; a style's small caps is book styling).
 */
export interface Emphasis {
  bold?: true
  italic?: true
  underline?: true
  smallCaps?: true
  superscript?: true
  subscript?: true
}

export const EMPHASIS_KEYS = ['bold', 'italic', 'underline', 'smallCaps', 'superscript', 'subscript'] as const satisfies ReadonlyArray<keyof Emphasis>

/** A run of text with one emphasis. Neighbouring runs never have the same emphasis (they are merged). */
export interface TextRun extends Emphasis {
  kind: 'text'
  text: string
}

/** A line break inside a paragraph (Shift-Enter). */
export interface LineBreakRun {
  kind: 'lineBreak'
}

/** A footnote reference: `footnote` is the index into `ManuscriptIR.footnotes`. */
export interface FootnoteRefRun {
  kind: 'footnoteRef'
  footnote: number
}

export type InlineRun = TextRun | LineBreakRun | FootnoteRefRun
/** Runs of a footnote's text (a note cannot hold another note). */
export type NoteRun = TextRun | LineBreakRun

// ---- blocks ---------------------------------------------------------------------------------------

/**
 * The semantic role of a paragraph (how a manuscript formats it):
 * - `body`: running text (indented first line in the usual manuscript format);
 * - `first`: the first paragraph of a chapter, or after a subheading, part title or scene break (or
 *   one styled First Paragraph): flush left in most presets;
 * - `blockQuote`: Block Quote, Epigraph, or a style based on them;
 * - `subheading`: a level-2/3 heading or chapter style (Subheading and styles based on it);
 * - `partTitle`: a level-1 chapter style that does not open a chapter (Part Title, or a level-1
 *   heading styled so): set on a page of its own, after a `sectionBreak`;
 * - `aligned`: centred or right-aligned text (`align` says which);
 * - `listItem`: a paragraph of a list item (`list` holds the marker).
 */
export type ParagraphRole = 'body' | 'first' | 'blockQuote' | 'subheading' | 'partTitle' | 'aligned' | 'listItem'

export interface ListInfo {
  /** The marker as it should be printed: "•", "◦", "▪" for bullets, "3." for ordered items. '' for a later paragraph of the same item. */
  marker: string
  /** Nesting depth, 0 for a top-level list. */
  depth: number
  ordered: boolean
}

export interface ParagraphBlock {
  kind: 'paragraph'
  role: ParagraphRole
  /** Centred or right-aligned (direct alignment or the style's). Absent: the format's default alignment. */
  align?: 'center' | 'right'
  /** Only on `listItem`. */
  list?: ListInfo
  runs: InlineRun[]
}

/**
 * A scene break. `source: 'node'` is the scene-break node; `'manual'` is a paragraph the build read
 * as one: "***", "* * *", "#", "###", an ornament ("❦", "⁂"), a paragraph in the Scene Break style, or
 * an empty paragraph between two paragraphs of a chapter (a blank-line break). Renderers print the
 * format's own scene-break marker (e.g. "#"), never `original`; manual ones are also listed in
 * `report.manualSceneBreaks` so the wizard can tell the user.
 */
export interface SceneBreakBlock {
  kind: 'sceneBreak'
  source: 'node' | 'manual'
  /** What the manuscript showed: the node's ornament or the paragraph's text ('' for a blank line). */
  original: string
}

/** A manual page break (the pageBreak node). Breaks right before a chapter are left out (a chapter starts a page anyway). */
export interface PageBreakBlock {
  kind: 'pageBreak'
}

/**
 * The block after it starts a new page (`page`) or a right-hand page (`recto`) because its style
 * breaks (Part Title, Dedication, a custom style), outside a chapter opening.
 */
export interface SectionBreakBlock {
  kind: 'sectionBreak'
  start: 'page' | 'recto'
}

export type ManuscriptBlock = ParagraphBlock | SceneBreakBlock | PageBreakBlock | SectionBreakBlock

// ---- structure ------------------------------------------------------------------------------------

/**
 * A chapter: opened by a chapter title block (Chapter Title, a level-1 chapter style based on it, or
 * an unstyled level-1 heading: the editor's `getChapters`), with the Chapter Number block(s) right
 * before the title. `blocks` runs to the next chapter (it may be empty).
 */
export interface ManuscriptChapter {
  /** 0-based, as the editor's chapters. */
  index: number
  /** Runs of the chapter number block(s) (several are joined with a line break); `[]` without one. */
  number: InlineRun[]
  /** Plain text of `number` ('' without one). */
  numberText: string
  /** Runs of the title ('[]' for an untitled chapter: an empty title block). */
  title: InlineRun[]
  /** Plain text of the title, without footnote text ('' when untitled). */
  titleText: string
  /** The title block's style id (e.g. 'chapter-title', or a custom style based on it). */
  titleStyleId: string
  blocks: ManuscriptBlock[]
}

export interface ManuscriptFootnote {
  /** Index in `ManuscriptIR.footnotes` (document order); `FootnoteRefRun.footnote` points here. */
  index: number
  /** 1-based number in its scope: the book, or its chapter (`book.footnotes.numbering`). */
  number: number
  /** The label the book shows ("3", or "†" with symbols). Manuscript renderers usually print `number`. */
  label: string
  /** Chapter index of the reference (-1: front matter). */
  chapter: number
  runs: NoteRun[]
}

// ---- report ---------------------------------------------------------------------------------------

export interface ManualSceneBreak {
  /** Chapter index (-1: front matter). */
  chapter: number
  /** 'symbol': "***", "#", an ornament or a Scene Break paragraph; 'blank': an empty paragraph. */
  kind: 'symbol' | 'blank'
  /** The paragraph's text ('' for a blank line). */
  original: string
}

/**
 * What the build resolved or dropped (for the wizard's checks). Counts, not content: nothing here
 * is exported.
 */
export interface ManuscriptReport {
  /** Pending tracked changes resolved as accepted (by change id; a change with several kinds counts once in `total` and once per kind). */
  trackedChanges: {
    total: number
    insertions: number
    deletions: number
    formatChanges: number
    /** Paragraph splits, joins, inserted and deleted breaks and paragraphs, style changes. */
    blockChanges: number
  }
  /** Comment threads anchored in the text (distinct ids): never exported. */
  comments: number
  /** Open re-writes whose passage is in the document: the manuscript text is exported, the versions are not. */
  openRewrites: number
  /** Manual scene breaks normalised to `sceneBreak` blocks, in document order. */
  manualSceneBreaks: ManualSceneBreak[]
  /** Book formatting dropped (counts of text runs / blocks carrying it). */
  strippedFormatting: {
    /** Runs with a direct font family. */
    fontFamily: number
    /** Runs with a direct font size. */
    fontSize: number
    /** Blocks with direct line height, spacing or indents. */
    blockLayout: number
  }
  /** Empty paragraphs left out (other than blank-line scene breaks). */
  emptyParagraphs: number
  /** Page breaks left out because a chapter starts right after them (or the document ends). */
  redundantPageBreaks: number
}

// ---- the IR ---------------------------------------------------------------------------------------

export interface ManuscriptIR {
  version: typeof MANUSCRIPT_IR_VERSION
  /** Content before the first chapter (title page lines, dedication, epigraph...). */
  frontMatter: ManuscriptBlock[]
  chapters: ManuscriptChapter[]
  /** Every footnote in document order. */
  footnotes: ManuscriptFootnote[]
  report: ManuscriptReport
}
