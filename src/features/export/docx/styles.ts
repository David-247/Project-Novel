import { AlignmentType, LineRuleType, type IParagraphPropertiesOptions, type IParagraphStyleOptions, type IStylesOptions } from 'docx'
import type { ManuscriptSettings } from '../settings/types'
import type { DocxLayout } from './layout'

/**
 * The manuscript's named styles. Every paragraph uses one of these and carries no direct paragraph
 * formatting (a manual page break excepted), so an editor at a publisher can restyle the whole
 * manuscript from the Styles pane. Ids are Word's built-in ids where Word has the style (Normal,
 * Heading1, Heading2, Header, FootnoteText, ListParagraph), so the Navigation Pane and Word's own
 * restyling find them.
 */
export const STYLE = {
  normal: 'Normal',
  firstParagraph: 'FirstParagraph',
  chapter: 'Heading1',
  subheading: 'Heading2',
  partTitle: 'PartTitle',
  sceneBreak: 'SceneBreak',
  blockQuote: 'BlockQuote',
  epigraph: 'Epigraph',
  dedication: 'Dedication',
  centered: 'Centered',
  flushRight: 'FlushRight',
  listParagraph: 'ListParagraph',
  endMarker: 'EndMarker',
  titleContact: 'TitlePageContact',
  titleTitle: 'TitlePageTitle',
  titleByline: 'TitlePageByline',
  header: 'Header',
  footnoteText: 'FootnoteText',
} as const

export type StyleId = (typeof STYLE)[keyof typeof STYLE]

/**
 * Paragraph properties of a style. The `docx` typings leave `pageBreakBefore` and `widowControl`
 * off style properties although Word reads them there (and the library writes them): typed here.
 */
type StyleParagraph = NonNullable<IParagraphStyleOptions['paragraph']> & Pick<IParagraphPropertiesOptions, 'pageBreakBefore' | 'widowControl'>

const style = (id: string, name: string, basedOn: string | undefined, paragraph: StyleParagraph, run: IParagraphStyleOptions['run'] = {}, next?: string): IParagraphStyleOptions => ({
  id,
  name,
  ...(basedOn ? { basedOn } : {}),
  ...(next ? { next } : {}),
  quickFormat: true,
  paragraph: paragraph as IParagraphStyleOptions['paragraph'],
  run,
})

/** No first-line indent, centred: headings, breaks and title-page lines. */
const centred = { alignment: AlignmentType.CENTER, indent: { firstLine: 0, left: 0, right: 0 } } as const

/**
 * `titleLines`: lines of the title page above the title (the contact block, or the word count line),
 * so the title still starts one third of the text area below the top margin.
 */
export function manuscriptStyles(settings: ManuscriptSettings, layout: DocxLayout, language: string, titleLines = 0): IStylesOptions {
  const font = settings.fontFamily.trim() || 'Times New Roman'
  const size = layout.fontHalfPoints
  const run = { font, size, color: '000000' }
  const body = { line: layout.bodyLine, lineRule: LineRuleType.AUTO, before: 0, after: 0 }
  const single = { line: 240, lineRule: LineRuleType.AUTO, before: 0, after: 0 }
  // No style is bold, larger or coloured: a manuscript is one face, one size (docs/manuscript-format.md).
  const plain = { bold: false, italics: false, color: '000000', size }
  return {
    default: {
      document: {
        run: { font, size, color: '000000', language: { value: language } },
        paragraph: { spacing: body },
      },
    },
    paragraphStyles: [
      style(STYLE.normal, 'Normal', undefined, {
        alignment: AlignmentType.LEFT,
        spacing: body,
        indent: { firstLine: layout.firstLineIndent },
        widowControl: true,
      }, run),
      style(STYLE.firstParagraph, 'First Paragraph', STYLE.normal, {
        indent: { firstLine: settings.indentFirstParagraph ? layout.firstLineIndent : 0 },
      }, {}, STYLE.normal),
      // A chapter opens a page, dropped `chapterDropFraction` of the text area; one blank line follows.
      style(STYLE.chapter, 'heading 1', STYLE.normal, {
        ...centred,
        pageBreakBefore: true,
        keepNext: true,
        keepLines: true,
        outlineLevel: 0,
        spacing: { ...body, before: layout.chapterDrop, after: layout.pitch },
      }, plain, STYLE.firstParagraph),
      style(STYLE.subheading, 'heading 2', STYLE.normal, { ...centred, keepNext: true, keepLines: true, outlineLevel: 1, spacing: body }, plain, STYLE.firstParagraph),
      style(STYLE.partTitle, 'Part Title', STYLE.normal, {
        ...centred,
        pageBreakBefore: true,
        keepNext: true,
        outlineLevel: 0,
        spacing: { ...body, before: layout.chapterDrop, after: layout.pitch },
      }, plain, STYLE.firstParagraph),
      style(STYLE.sceneBreak, 'Scene Break', STYLE.normal, { ...centred, keepNext: true }, {}, STYLE.firstParagraph),
      style(STYLE.blockQuote, 'Block Quote', STYLE.normal, { indent: { firstLine: 0, left: layout.firstLineIndent, right: layout.firstLineIndent } }),
      style(STYLE.epigraph, 'Epigraph', STYLE.blockQuote, {}),
      style(STYLE.dedication, 'Dedication', STYLE.normal, centred),
      style(STYLE.centered, 'Centered', STYLE.normal, centred),
      style(STYLE.flushRight, 'Flush Right', STYLE.normal, { alignment: AlignmentType.RIGHT, indent: { firstLine: 0, left: 0, right: 0 } }),
      style(STYLE.listParagraph, 'List Paragraph', STYLE.normal, { indent: { left: layout.firstLineIndent, hanging: Math.round(layout.firstLineIndent / 2) } }),
      style(STYLE.endMarker, 'End Marker', STYLE.normal, centred),
      // Title page: the contact block single-spaced at the top margin, the word count on its first
      // line at a right tab; the title one third down the text area; a blank double line; the by-line.
      style(STYLE.titleContact, 'Title Page Contact', STYLE.normal, {
        indent: { firstLine: 0, left: 0, right: 0 },
        spacing: single,
        rightTabStop: layout.textWidth,
      }),
      style(STYLE.titleTitle, 'Title Page Title', STYLE.normal, {
        ...centred,
        keepNext: true,
        spacing: { ...body, before: Math.max(0, layout.titleDrop - titleLines * layout.singleLine) },
      }, plain, STYLE.titleByline),
      style(STYLE.titleByline, 'Title Page Byline', STYLE.normal, { ...centred, spacing: { ...body, before: layout.pitch } }),
      style(STYLE.header, 'header', STYLE.normal, {
        alignment: AlignmentType.RIGHT,
        indent: { firstLine: 0, left: 0, right: 0 },
        spacing: single,
      }),
      // Footnotes: body font and size (no reduction), single-spaced, no first-line indent.
      style(STYLE.footnoteText, 'footnote text', STYLE.normal, { indent: { firstLine: 0 }, spacing: single }, { size }),
    ],
  }
}
