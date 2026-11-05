import type { DocNodeJSON } from '@/shared/document'
import type { RewriteRecord, RewriteVersion } from '@/shared/store'
import { REWRITE_BLOCK_ATTR } from '@/shared/rewrite'

export type { RewriteRecord, RewriteVersion }

/** rewrites.json (docs/project-format.md, "rewrites.json"). */
export const REWRITES_FILE = 'rewrites.json'
export const REWRITES_VERSION = 1

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/
export const isRewriteId = (v: unknown): v is string => typeof v === 'string' && ID_RE.test(v)

export function newRewriteId(prefix = 'rw'): string {
  const c = globalThis.crypto
  const raw = c?.randomUUID ? c.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  return `${prefix}-${raw.replace(/[^A-Za-z0-9-]/g, '')}`
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isDate = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v))
/** A doc JSON with at least one block (the schema check happens when it is loaded into an editor). */
const isPassageDoc = (v: unknown): v is DocNodeJSON =>
  isObject(v) && v.type === 'doc' && Array.isArray(v.content) && v.content.length > 0 && v.content.every((n) => isObject(n) && typeof n.type === 'string')

const RECORD_KEYS = ['id', 'createdAt', 'anchor', 'original', 'versions', 'currentVersionId', 'status', 'originalChanged'] as const
const VERSION_KEYS = ['id', 'name', 'doc', 'updatedAt'] as const

function extraOf(raw: Record<string, unknown>, known: readonly string[]): Record<string, unknown> | undefined {
  const extra: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw)) if (!known.includes(k)) extra[k] = v
  return Object.keys(extra).length ? extra : undefined
}

function parseVersion(raw: unknown, index: number): RewriteVersion | null {
  if (!isObject(raw) || !isRewriteId(raw.id) || !isPassageDoc(raw.doc)) return null
  const extra = extraOf(raw, VERSION_KEYS)
  return {
    id: raw.id,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name : `Version ${index + 1}`,
    doc: raw.doc,
    updatedAt: isDate(raw.updatedAt) ? raw.updatedAt : new Date(0).toISOString(),
    ...(extra ? { extra } : {}),
  }
}

/** A re-write from rewrites.json, or null when it is not usable (it is then kept verbatim). */
export function parseRewrite(raw: unknown): RewriteRecord | null {
  if (!isObject(raw) || !isRewriteId(raw.id) || !isRewriteId(raw.anchor) || !isPassageDoc(raw.original) || !Array.isArray(raw.versions)) return null
  const versions = raw.versions.map(parseVersion)
  if (versions.length === 0 || versions.some((v) => v === null)) return null
  const ids = new Set(versions.map((v) => v!.id))
  if (ids.size !== versions.length) return null
  const extra = extraOf(raw, RECORD_KEYS)
  return {
    id: raw.id,
    createdAt: isDate(raw.createdAt) ? raw.createdAt : new Date(0).toISOString(),
    anchor: raw.anchor,
    original: raw.original,
    versions: versions as RewriteVersion[],
    ...(typeof raw.currentVersionId === 'string' && ids.has(raw.currentVersionId) ? { currentVersionId: raw.currentVersionId } : {}),
    // Unknown statuses (a newer Novel) are kept out of the way: treated as resolved, written back as read.
    status: raw.status === 'open' ? 'open' : 'resolved',
    ...(raw.originalChanged === true ? { originalChanged: true } : {}),
    ...(raw.status !== 'open' && raw.status !== 'resolved' ? { extra: { ...(extra ?? {}), status: raw.status } } : extra ? { extra } : {}),
  }
}

export interface RewritesFileData {
  rewrites: RewriteRecord[]
  /** Unknown top-level keys. */
  extra: Record<string, unknown>
  /** Entries this version cannot use, written back unchanged after the others. */
  unreadable: unknown[]
  /** The file's `version` when it is newer than this Novel's. */
  newer?: number
}

/** Parse the JSON of rewrites.json (already an object; see the storage slice's side files). Throws when `rewrites` is not a list. */
export function parseRewritesFile(data: unknown): RewritesFileData {
  if (!isObject(data)) return { rewrites: [], extra: {}, unreadable: [] }
  if (data.rewrites !== undefined && !Array.isArray(data.rewrites)) throw new Error('rewrites.json: rewrites is not a list')
  const extra = extraOf(data, ['version', 'rewrites']) ?? {}
  const rewrites: RewriteRecord[] = []
  const unreadable: unknown[] = []
  const seen = new Set<string>()
  for (const raw of (data.rewrites as unknown[] | undefined) ?? []) {
    const r = parseRewrite(raw)
    if (r && !seen.has(r.id) && !seen.has(`anchor:${r.anchor}`)) {
      seen.add(r.id)
      seen.add(`anchor:${r.anchor}`)
      rewrites.push(r)
    } else unreadable.push(raw)
  }
  const v = data.version
  return { rewrites, extra, unreadable, ...(typeof v === 'number' && Number.isInteger(v) && v > REWRITES_VERSION ? { newer: v } : {}) }
}

function serializeVersion(v: RewriteVersion): Record<string, unknown> {
  return { ...(v.extra ?? {}), id: v.id, name: v.name, doc: v.doc, updatedAt: v.updatedAt }
}

export function serializeRewrite(r: RewriteRecord): Record<string, unknown> {
  return {
    ...(r.extra ?? {}),
    id: r.id,
    createdAt: r.createdAt,
    anchor: r.anchor,
    original: r.original,
    versions: r.versions.map(serializeVersion),
    ...(r.currentVersionId ? { currentVersionId: r.currentVersionId } : {}),
    // A status this Novel did not know stays in `extra` (written back above) unless it changed it.
    ...(r.extra && 'status' in r.extra ? {} : { status: r.status }),
    ...(r.originalChanged ? { originalChanged: true } : {}),
  }
}

export function serializeRewritesFile(file: Omit<RewritesFileData, 'newer'>): Record<string, unknown> {
  return { ...file.extra, version: REWRITES_VERSION, rewrites: [...file.rewrites.map(serializeRewrite), ...file.unreadable] }
}

// ---- Passage JSON -------------------------------------------------------------------------------

/** A copy of block JSON without the re-write anchor attribute (snapshots and versions carry none). */
export function withoutAnchor(node: DocNodeJSON): DocNodeJSON {
  const out: DocNodeJSON = { ...node }
  if (node.attrs && REWRITE_BLOCK_ATTR in node.attrs) {
    const { [REWRITE_BLOCK_ATTR]: _drop, ...rest } = node.attrs
    void _drop
    if (Object.keys(rest).length) out.attrs = rest
    else delete out.attrs
  }
  if (node.content) out.content = node.content.map(withoutAnchor)
  return out
}

/** `{ type: 'doc', content: blocks }`, anchors removed. */
export function passageDoc(blocks: readonly DocNodeJSON[]): DocNodeJSON {
  return { type: 'doc', content: blocks.map(withoutAnchor) }
}

/** "Version 3": the first free "Version N" name after the existing ones. */
export function nextVersionName(versions: readonly RewriteVersion[]): string {
  const names = new Set(versions.map((v) => v.name))
  let n = versions.length + 1
  while (names.has(`Version ${n}`)) n++
  return `Version ${n}`
}

/** A trimmed name; the old one when the new one is empty. At most 60 characters. */
export function cleanVersionName(name: string, fallback: string): string {
  const t = name.replace(/\s+/g, ' ').trim().slice(0, 60)
  return t || fallback
}
