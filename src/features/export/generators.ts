import { createDocxRenderer, type DocxRendererOptions, type DocxRenderSettings } from './docx'
import { createPdfRenderer, type ManuscriptMeta, type PdfRendererOptions } from './pdf'
import { systemLocale } from './settings'
import { fromManuscriptRenderer, type ExportJob, type ExportRenderer, type WizardFormat } from './wizard'

/**
 * The export wizard's real renderers: the DOCX generator (docx/) and the PDF generator (pdf/), adapted
 * to the wizard's ExportJob. The composition root registers them (`setExportRenderers`). Both take the
 * title page's title, contact block and word count from the job, so the two files state the same count
 * (the wizard computes it once: `titlePageWordCount`), and the text's language from the OS locale.
 */

/** The DOCX generator's settings for a job; `language` is the text's BCP 47 tag (DOCX proofing). */
export function docxSettingsOf(job: ExportJob, language: string = systemLocale()): DocxRenderSettings {
  return { ...job.settings, info: { title: job.titlePage.title, contact: job.titlePage.contact, wordCount: job.titlePage.wordCount, language } }
}

/** The PDF generator's meta for a job; `language` as for the DOCX. */
export function pdfMetaOf(job: ExportJob, language: string = systemLocale()): ManuscriptMeta {
  return { title: job.titlePage.title, contact: job.titlePage.contact, wordCount: job.titlePage.wordCount, language }
}

export interface ManuscriptExportRendererOptions {
  docx?: DocxRendererOptions
  /** The PDF renderer's options but `meta` (that comes from each job). */
  pdf?: Omit<PdfRendererOptions, 'meta'>
  /**
   * The text's language for both files (BCP 47), read per render; default: the OS locale, the same
   * source as the default paper size (`paperFromLocale`). Each generator falls back to English when
   * the tag is unusable.
   */
  language?: () => string
}

export function createManuscriptExportRenderers(options: ManuscriptExportRendererOptions = {}): Record<WizardFormat, ExportRenderer> {
  const language = options.language ?? systemLocale
  return {
    docx: fromManuscriptRenderer('docx', createDocxRenderer(options.docx), (job) => docxSettingsOf(job, language())),
    // A PDF renderer per render: its meta is the job's.
    pdf: {
      format: 'pdf',
      render: (job, renderOptions) => createPdfRenderer({ ...options.pdf, meta: pdfMetaOf(job, language()) }).render(job.ir, job.settings, renderOptions),
    },
  }
}
