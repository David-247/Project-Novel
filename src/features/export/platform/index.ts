/**
 * Export platform: the Rust side of export (Save dialog, atomic file writes, the offline Typst PDF
 * render, reveal in folder). The export slice's generators build on this; the slice index re-exports it.
 */
export {
  base64ToBytes,
  cancelRender,
  EXPORT_COMMANDS,
  EXPORT_HEADERS,
  ExportPlatformError,
  openExportedFile,
  pickSavePath,
  renderPdf,
  revealInFolder,
  writeExportFile,
} from './ipc'
export type {
  ExportErrorKind,
  ExportFileKind,
  ExportFontReport,
  ExportFontRole,
  RenderPdfOptions,
  RenderPdfResult,
  SaveTarget,
  TypstDiagnostic,
  WrittenExport,
} from './ipc'
