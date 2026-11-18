// The DOCX manuscript generator (Phase 4; docs/docx-export.md). Re-exported by the export slice index.
// - createDocxRenderer(options) -> ManuscriptRenderer<DocxRenderSettings>: render(ir, settings, { signal,
//   onProgress }) builds the .docx in a Web Worker (in the page, loaded on demand, where there is none).
// - DocxRenderSettings = ManuscriptSettings & { info: ManuscriptExportInfo } (title, contact, language,
//   the title page's word count, which the wizard passes); DOCX_MIME_TYPE.
// The build itself (./build.ts, the `docx` library) is deliberately not exported here: a static import
// would pull the library into the app's main bundle.
export { createDocxRenderer } from './renderer'
export type { DocxRendererOptions } from './renderer'
export { DOCX_MIME_TYPE } from './types'
export type { DocxRenderSettings, ManuscriptExportInfo } from './types'
export { docxFontReport } from './font'
export type { DocxFontReport } from './font'
