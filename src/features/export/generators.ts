import { createDocxRenderer, type DocxRendererOptions, type DocxRenderSettings } from './docx'
import { createPdfRenderer, type ManuscriptMeta, type PdfRendererOptions } from './pdf'
import { fromManuscriptRenderer, type ExportJob, type ExportRenderer, type WizardFormat } from './wizard'

/**
 * The export wizard's real renderers: the DOCX generator (docx/) and the PDF generator (pdf/), adapted
 * to the wizard's ExportJob. The composition root registers them (`setExportRenderers`). Both take the
 * title page's title, contact block and word count from the job, so the two files state the same count
 * (the wizard computes it once: `titlePageWordCount`).
 */

/** The DOCX generator's settings for a job. */
export function docxSettingsOf(job: ExportJob): DocxRenderSettings {
  return { ...job.settings, info: { title: job.titlePage.title, contact: job.titlePage.contact, wordCount: job.titlePage.wordCount } }
}

/** The PDF generator's meta for a job. */
export function pdfMetaOf(job: ExportJob): ManuscriptMeta {
  return { title: job.titlePage.title, contact: job.titlePage.contact, wordCount: job.titlePage.wordCount }
}

export interface ManuscriptExportRendererOptions {
  docx?: DocxRendererOptions
  /** The PDF renderer's options but `meta` (that comes from each job). */
  pdf?: Omit<PdfRendererOptions, 'meta'>
}

export function createManuscriptExportRenderers(options: ManuscriptExportRendererOptions = {}): Record<WizardFormat, ExportRenderer> {
  return {
    docx: fromManuscriptRenderer('docx', createDocxRenderer(options.docx), docxSettingsOf),
    // A PDF renderer per render: its meta is the job's.
    pdf: {
      format: 'pdf',
      // Its font report goes to the caller's onReport and to the run (the success screen names the font).
      render: (job, renderOptions) =>
        createPdfRenderer({
          ...options.pdf,
          meta: pdfMetaOf(job),
          onReport: (report) => {
            options.pdf?.onReport?.(report)
            renderOptions?.onFont?.(report.font)
          },
        }).render(job.ir, job.settings, renderOptions),
    },
  }
}
