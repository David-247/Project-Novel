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
  onProjectOpened,
  createProjectAt,
  openProjectAt,
  type OpenedProject,
  type SaveOptions,
} from './project'

// Low-level file helpers (Rust commands; atomic temp-file + fsync + rename)
export { writeFileAtomic, readTextFile, MENU_EVENTS } from './ipc'

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
