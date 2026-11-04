// Public interface of the "storage" slice. Other slices may import ONLY from here.
//
// Project folder format (docs/project-format.md):
//   project.json     metadata + schema version
//   manuscript.json  ProseMirror doc JSON
//   index.sqlite     Drizzle-managed index (revisions)

// Actions (show their own error dialogs; resolve true on success)
export {
  newProject,
  openProject,
  saveProject,
  closeProject,
  confirmUnsavedChanges,
  loadRecentProjects,
  getCurrentProjectPath,
  getCurrentProjectMeta,
  updateProjectDetails,
  onProjectOpened,
  createProjectAt,
  openProjectAt,
  isSaveInFlight,
  restoreRecovery,
  discardRecovery,
  clearRecoveryData,
  hasPendingRecovery,
  reopenRecoveryPrompt,
  type OpenedProject,
  type SaveOptions,
} from './project'

// Autosave + crash recovery (.recovery/manuscript.json; see docs/project-format.md)
export { startAutosave, stopAutosave, autosaveNow, AUTOSAVE_INTERVAL_MS, AUTOSAVE_RETRY_DELAYS_MS } from './autosave'
export {
  RECOVERY_DIR,
  RECOVERY_FILE,
  RECOVERY_FORMAT,
  RECOVERY_VERSION,
  parseRecovery,
  type RecoverySnapshot,
} from './recovery'

// Low-level file helpers (Rust commands; atomic temp-file + fsync + rename)
export { writeFileAtomic, writeFilesAtomic, readTextFile, MENU_EVENTS } from './ipc'
export type { BatchFile } from './ipc'

// Project side files: named JSON files beside manuscript.json owned by a slice (comments.json, ...),
// saved in one batch with the manuscript, snapshotted for crash recovery, guarded when damaged or
// newer (see side-files.ts and docs/project-format.md, "Side files").
export { registerSideFile } from './side-files'
export type { ProjectSideFile } from './side-files'

// Book settings file (book.json; see docs/project-format.md)
export { BOOK_FILE, BOOK_FORMAT, BOOK_VERSION, parseBook, serializeBook, type BookParseResult } from './book-file'

// Format
export {
  PROJECT_FORMAT,
  PROJECT_SCHEMA_VERSION,
  PROJECT_FILE,
  MANUSCRIPT_FILE,
  INDEX_FILE,
  ProjectError,
  joinPath,
  parseProjectMeta,
  parseManuscript,
  type ProjectMeta,
  type ProjectErrorCode,
} from './format'
export { REVISION_KINDS, INDEX_SCHEMA_VERSION, type RevisionKind } from './schema'

// App wiring
export { useStorageIntegration } from './integration'
export { SaveStatusIndicator } from './SaveStatusIndicator'
export { RecoveryDialog } from './RecoveryDialog'
export { NoProjectActions, RecoveryStatus } from './ProjectStatusControls'
