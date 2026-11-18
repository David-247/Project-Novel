// Public interface of the "export" slice (Phase 4: manuscript export). Other slices import ONLY from here.
// The slice is built from parts with separate owners; each part keeps its exports in its own block.

// --- Manuscript export settings (src/features/export/settings/*) --------------------------------
// Pure API for the DOCX / Typst generators and the export wizard (docs/manuscript-format.md):
// - types: ManuscriptSettings, ContactDetails, ContactOverride, WordRange ...
// - PRESETS / STANDARD_PRESET / CLASSIC_PRESET, applyPreset(), FONT_FALLBACKS
// - defaultManuscriptSettings(locale), paperFromLocale(locale)
// - GENRE_WORD_COUNTS, checkWordCount(genre, count, { debut })
// - roundWordCount(), formatWordCount(), surnameOf(), runningHeader(), resolveContact(), bylineName()
// - parseExportFile() / serializeExportFile(): export.json (docs/project-format.md)
// Project state (export.json is a storage side file; register it once at app start):
// - registerExportSideFile()
// - getManuscriptSettings() / useManuscriptSettings(), updateManuscriptSettings(), setPreset(),
//   getLastOutputFolder() / useLastOutputFolder() / setLastOutputFolder() (machine-local: preferences.json by
//   project id, never export.json), getContactOverride() / useContactOverride(), setContactOverride()
// - getResolvedContact() / useResolvedContact(): the app author profile + the project's override
export * from './settings'
// --- end of the export settings block ------------------------------------------------------------

// --- Manuscript IR (src/features/export/ir/*) ----------------------------------------------------
// The renderer-neutral manuscript (docs/manuscript-ir.md):
// - buildManuscript(doc, styles, options) -> ManuscriptIR (pending tracked changes accepted)
// - ManuscriptRenderer<TSettings = ManuscriptSettings>, RenderOptions / RenderProgress, ExportFormat,
//   assertManuscriptVersion(), abortError() / isAbortError() / throwIfAborted()
// - manuscriptPlainText() / runsText(), createMockRenderer(), and the feature fixtures
export * from './ir'
// --- end of the manuscript IR block --------------------------------------------------------------

// --- Export platform (src/features/export/platform/*) --------------------------------------------
// The Rust side of export over IPC: pickSavePath() (Save dialog), writeExportFile() (atomic write),
// renderPdf() / cancelRender() (the bundled, offline Typst sidecar), revealInFolder(), base64ToBytes(),
// ExportPlatformError, EXPORT_COMMANDS / EXPORT_HEADERS and their types.
export * from './platform'
// --- end of the export platform block ------------------------------------------------------------

// --- PDF generator (src/features/export/pdf/*) ---------------------------------------------------
// createPdfRenderer({ meta }) (ManuscriptRenderer for PDF via the bundled Typst template), buildPdfData(),
// manuscriptWordCount(), lineMetrics() / fontRoleOf(); ManuscriptMeta, PdfRenderReport.
export * from './pdf'
// --- end of the PDF generator block --------------------------------------------------------------
// --- DOCX generator (src/features/export/docx/*) -------------------------------------------------
// createDocxRenderer() -> ManuscriptRenderer<DocxRenderSettings> (built in a Web Worker),
// DocxRenderSettings / ManuscriptExportInfo, DOCX_MIME_TYPE, manuscriptWordCount(). docs/docx-export.md.
export * from './docx'
// --- end of the DOCX generator block -------------------------------------------------------------
