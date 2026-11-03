import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/** Version of the index.sqlite schema, stored in `PRAGMA user_version`. */
export const INDEX_SCHEMA_VERSION = 1

export const REVISION_KINDS = ['manual', 'autosave'] as const
export type RevisionKind = (typeof REVISION_KINDS)[number]

/**
 * One row per save. Phase 1 records metadata only (`path` points at the file
 * that was written); `content` is reserved for stored snapshots later.
 */
export const revisions = sqliteTable('revisions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** ISO 8601 timestamp. */
  createdAt: text('created_at').notNull(),
  kind: text('kind', { enum: REVISION_KINDS }).notNull(),
  /** Size in bytes of the saved manuscript JSON (UTF-8). */
  byteSize: integer('byte_size').notNull(),
  /** Project-relative path of the saved file (e.g. "manuscript.json"), if any. */
  path: text('path'),
  /** Inline snapshot content, if any. */
  content: text('content'),
})

// Future (not Phase 1): a `comments` table (id, created_at, anchor, body, resolved)
// will be added here with INDEX_SCHEMA_VERSION 2 and a matching bootstrap step.

export type RevisionRow = typeof revisions.$inferSelect
export type NewRevision = typeof revisions.$inferInsert

/**
 * Statements that create schema version 1 from an empty database. Must match
 * the Drizzle table above (a unit test checks the column names).
 */
export const BOOTSTRAP_V1: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('manual', 'autosave')),
    byte_size INTEGER NOT NULL,
    path TEXT,
    content TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS revisions_created_at ON revisions (created_at)`,
  `PRAGMA user_version = 1`,
]
