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
