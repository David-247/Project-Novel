// Public interface of the export slice's PDF generator (re-exported by src/features/export/index.ts).
//
// - createPdfRenderer({ meta, preferInstalledFont?, onReport? }) -> a ManuscriptRenderer for PDF: the IR
//   and the settings become the data of the bundled Typst template (`manuscript`), rendered offline by
//   the Typst sidecar. `lastReport` / `onReport` name the font actually used (bundled fallback or not).
// - buildPdfData(ir, settings, meta): the template's data (pure; snapshot-tested).
// - manuscriptWordCount(ir): the title page's word count (equals countManuscript's body words).
// - lineMetrics() / fontRoleOf(): the double-spacing pitch both generators share.
export { createPdfRenderer } from './renderer'
export type { PdfFontReport, PdfRenderer, PdfRendererOptions, PdfRenderReport } from './renderer'
export { buildPdfData, PDF_DATA_VERSION, PDF_TEMPLATE_ID } from './data'
export type { ManuscriptMeta, PdfData, PdfBlock, PdfRun, PdfTitlePage } from './data'
export { manuscriptWordCount } from './word-count'
export { FONT_METRICS, fontRoleOf, isKnownFamily, KNOWN_FAMILIES, lineMetrics } from './metrics'
export type { FontMetrics, LineMetrics } from './metrics'
