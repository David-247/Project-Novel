import type { DocJSON, DocNodeJSON } from '@/shared/document'

/** Marker identifying a Novel project.json. */
export const PROJECT_FORMAT = 'novel-project'
/** Current project.json schema version. Bump on breaking format changes. */
export const PROJECT_SCHEMA_VERSION = 1

export const PROJECT_FILE = 'project.json'
export const MANUSCRIPT_FILE = 'manuscript.json'
export const INDEX_FILE = 'index.sqlite'

/** Contents of project.json. */
export interface ProjectMeta {
  format: typeof PROJECT_FORMAT
  schemaVersion: number
  /** Random UUID, stable for the project's lifetime. */
  id: string
  title: string
  /** ISO 8601 timestamps. */
  createdAt: string
  updatedAt: string
}

export type ProjectErrorCode =
  | 'missing-folder'
  | 'missing-file'
  | 'corrupt-file'
  | 'not-a-project'
  | 'unsupported-version'
  | 'already-exists'
  | 'no-editor'
  | 'disk-full'
  | 'read-only'
  | 'write-denied'
  | 'io'

/** An expected storage failure, carrying a message suitable for an error dialog. */
export class ProjectError extends Error {
  readonly code: ProjectErrorCode
  constructor(code: ProjectErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ProjectError'
    this.code = code
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** The path separator a folder path uses (backslash for Windows paths). */
function separatorOf(path: string): string {
  return path.includes('\\') && !path.includes('/') ? '\\' : '/'
}

/** Strip trailing separators (keeping a bare root such as "/" or "C:\"). */
export function trimTrailingSeparators(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  if (trimmed === '') return path.slice(0, 1)
  if (/^[A-Za-z]:$/.test(trimmed)) return trimmed + separatorOf(path)
  return trimmed
}

/** Join a project folder and a file name using the folder's own separator. */
export function joinPath(folder: string, file: string): string {
  const base = trimTrailingSeparators(folder)
  const sep = separatorOf(folder)
  return base.endsWith(sep) ? base + file : base + sep + file
}

/** Last path segment ("My Novel" for "C:\Books\My Novel\"). */
export function baseName(path: string): string {
  const parts = trimTrailingSeparators(path).split(/[\\/]/)
  return parts[parts.length - 1] || path
}

export function newProjectMeta(title: string, now: Date = new Date(), id: string = crypto.randomUUID()): ProjectMeta {
  const iso = now.toISOString()
  return { format: PROJECT_FORMAT, schemaVersion: PROJECT_SCHEMA_VERSION, id, title, createdAt: iso, updatedAt: iso }
}

function parseJSON(text: string, fileName: string): unknown {
  try {
    return JSON.parse(text)
  } catch (cause) {
    throw new ProjectError('corrupt-file', `${fileName} is damaged and could not be read (it is not valid JSON).`, {
      cause,
    })
  }
}

/** Parse and validate project.json, including the schema-version check. */
export function parseProjectMeta(text: string): ProjectMeta {
  const data = parseJSON(text, PROJECT_FILE)
  if (!isObject(data) || data.format !== PROJECT_FORMAT) {
    throw new ProjectError('not-a-project', `${PROJECT_FILE} does not describe a Novel project.`)
  }
  const v = data.schemaVersion
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    throw new ProjectError('corrupt-file', `${PROJECT_FILE} is damaged: its schema version is missing or invalid.`)
  }
  if (v > PROJECT_SCHEMA_VERSION) {
    throw new ProjectError(
      'unsupported-version',
      `This project was saved by a newer version of Novel (format version ${v}). ` +
        `Please update Novel to open it.`,
    )
  }
  for (const key of ['id', 'title', 'createdAt', 'updatedAt'] as const) {
    if (typeof data[key] !== 'string') {
      throw new ProjectError('corrupt-file', `${PROJECT_FILE} is damaged: "${key}" is missing or invalid.`)
    }
  }
  // Future: migrate older schema versions here before returning.
  return {
    format: PROJECT_FORMAT,
    schemaVersion: v,
    id: data.id as string,
    title: data.title as string,
    createdAt: data.createdAt as string,
    updatedAt: data.updatedAt as string,
  }
}

export function serializeProjectMeta(meta: ProjectMeta): string {
  return JSON.stringify(meta, null, 2) + '\n'
}

function isDocNode(v: unknown, depth: number): v is DocNodeJSON {
  if (!isObject(v) || typeof v.type !== 'string' || depth > 200) return false
  if (v.text !== undefined && typeof v.text !== 'string') return false
  if (v.attrs !== undefined && !isObject(v.attrs)) return false
  if (v.marks !== undefined && !(Array.isArray(v.marks) && v.marks.every((m) => isObject(m) && typeof m.type === 'string')))
    return false
  if (v.content !== undefined) {
    if (!Array.isArray(v.content)) return false
    for (const child of v.content) if (!isDocNode(child, depth + 1)) return false
  }
  return true
}

/** True if `v` has the shape of a ProseMirror doc JSON. Schema-level checks are the editor's job. */
export function isDocJSON(v: unknown): v is DocJSON {
  return isObject(v) && v.type === 'doc' && isDocNode(v, 0)
}

/** Parse and validate manuscript.json (a ProseMirror doc JSON). */
export function parseManuscript(text: string): DocJSON {
  const data = parseJSON(text, MANUSCRIPT_FILE)
  if (!isDocJSON(data)) {
    throw new ProjectError('corrupt-file', `${MANUSCRIPT_FILE} is damaged: it does not contain a valid document.`)
  }
  return data
}

/** Compact JSON: manuscripts can be large, so no pretty-printing. */
export function serializeManuscript(doc: DocJSON): string {
  return JSON.stringify(doc)
}
