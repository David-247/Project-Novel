import type { ContactDetails, ManuscriptSettings } from '../settings/types'

/**
 * What a manuscript file needs besides the IR and the format settings: the title, the author's
 * contact block and the language. The wizard fills it from the project and the resolved contact
 * (`getResolvedContact()`); nothing here is stored by the renderer.
 */
export interface ManuscriptExportInfo {
  /** The manuscript title (title page, running header when `header.shortTitle` is empty, document properties). */
  title: string
  /** The app author profile with the project's override applied. */
  contact: ContactDetails
  /** BCP 47 language of the text, for Word's proofing and the document properties (default 'en-US'). */
  language?: string
  /**
   * The count the title page rounds. Default: the manuscript's own count from the IR with footnotes
   * (`manuscriptWordCount(ir).total`), which equals the live word count with "Include footnotes".
   */
  wordCount?: number
}

/** The DOCX renderer's settings: the export settings plus the manuscript's details. */
export type DocxRenderSettings = ManuscriptSettings & { info: ManuscriptExportInfo }

export const DOCX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
