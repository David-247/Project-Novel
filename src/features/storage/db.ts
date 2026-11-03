import Database from '@tauri-apps/plugin-sql'
import { drizzle, type SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy'
import { BOOTSTRAP_V1, INDEX_SCHEMA_VERSION, revisions, type RevisionKind } from './schema'
import * as schema from './schema'

export type IndexDb = SqliteRemoteDatabase<typeof schema>

export interface ProjectIndex {
  db: IndexDb
  close(): Promise<void>
}

/** Minimal surface of the Tauri SQL plugin used here (eases mocking). */
export interface SqlConnection {
  execute(query: string, bindValues?: unknown[]): Promise<unknown>
  select<T>(query: string, bindValues?: unknown[]): Promise<T>
  close(db?: string): Promise<boolean>
}

/** Drizzle sqlite-proxy driver over a Tauri SQL connection. */
export function createDrizzle(conn: SqlConnection): IndexDb {
  return drizzle(
    async (sql, params, method) => {
      if (method === 'run') {
        await conn.execute(sql, params)
        return { rows: [] }
      }
      const rows = (await conn.select<Record<string, unknown>[]>(sql, params)).map((r) => Object.values(r))
      return { rows: method === 'get' ? (rows[0] as unknown as unknown[]) : rows }
    },
    { schema },
  )
}

/** Create or upgrade the index schema. Returns false if the file is from a newer version. */
export async function bootstrapIndex(conn: SqlConnection): Promise<boolean> {
  const [row] = await conn.select<{ user_version: number }[]>('PRAGMA user_version')
  const version = row?.user_version ?? 0
  if (version > INDEX_SCHEMA_VERSION) return false
  if (version < 1) {
    for (const stmt of BOOTSTRAP_V1) await conn.execute(stmt)
  }
  return true
}

/** The connection string the Tauri SQL plugin expects for an absolute file path. */
export function sqliteUrl(absolutePath: string): string {
  return `sqlite:${absolutePath}`
}

/**
 * Open (creating if needed) a project's index.sqlite. Returns null if the
 * index was written by a newer app version; the index is secondary data, so
 * the project still opens without it.
 */
export async function openProjectIndex(absolutePath: string): Promise<ProjectIndex | null> {
  const url = sqliteUrl(absolutePath)
  const conn = await Database.load(url)
  if (!(await bootstrapIndex(conn))) {
    await conn.close(url)
    return null
  }
  return { db: createDrizzle(conn), close: async () => void (await conn.close(url)) }
}

export async function recordRevision(
  index: ProjectIndex,
  r: { kind: RevisionKind; byteSize: number; path?: string | null; createdAt?: string },
): Promise<void> {
  await index.db.insert(revisions).values({
    createdAt: r.createdAt ?? new Date().toISOString(),
    kind: r.kind,
    byteSize: r.byteSize,
    path: r.path ?? null,
  })
}
