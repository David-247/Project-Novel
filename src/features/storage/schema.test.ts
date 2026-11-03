import { getTableConfig } from 'drizzle-orm/sqlite-core'
import { desc } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { bootstrapIndex, createDrizzle, sqliteUrl, type SqlConnection } from './db'
import { BOOTSTRAP_V1, INDEX_SCHEMA_VERSION, revisions } from './schema'

function fakeConn(userVersion = 0, selectRows: Record<string, unknown>[] = []) {
  const executed: { sql: string; params?: unknown[] }[] = []
  const conn: SqlConnection = {
    execute: vi.fn(async (sql: string, params?: unknown[]) => {
      executed.push({ sql, params })
      return { rowsAffected: 1 }
    }),
    select: vi.fn(async (sql: string) =>
      (sql.startsWith('PRAGMA user_version') ? [{ user_version: userVersion }] : selectRows) as never,
    ),
    close: vi.fn(async () => true),
  }
  return { conn, executed }
}

describe('index.sqlite schema', () => {
  it('bootstrap SQL creates every Drizzle column', () => {
    const create = BOOTSTRAP_V1[0]
    for (const col of getTableConfig(revisions).columns) expect(create).toContain(col.name)
    expect(BOOTSTRAP_V1.at(-1)).toBe(`PRAGMA user_version = ${INDEX_SCHEMA_VERSION}`)
  })

  it('bootstraps an empty database once', async () => {
    const fresh = fakeConn(0)
    expect(await bootstrapIndex(fresh.conn)).toBe(true)
    expect(fresh.executed.map((e) => e.sql)).toEqual([...BOOTSTRAP_V1])

    const existing = fakeConn(1)
    expect(await bootstrapIndex(existing.conn)).toBe(true)
    expect(existing.executed).toEqual([])
  })

  it('refuses an index from a newer version', async () => {
    expect(await bootstrapIndex(fakeConn(INDEX_SCHEMA_VERSION + 1).conn)).toBe(false)
  })

  it('drizzle inserts revisions through the proxy', async () => {
    const { conn, executed } = fakeConn()
    const db = createDrizzle(conn)
    await db.insert(revisions).values({ createdAt: 'T', kind: 'manual', byteSize: 12, path: 'manuscript.json' })
    expect(executed[0].sql).toMatch(/insert into "revisions"/i)
    expect(executed[0].params).toEqual(expect.arrayContaining(['T', 'manual', 12, 'manuscript.json']))
  })

  it('drizzle maps selected rows back to objects', async () => {
    const row = { id: 1, created_at: 'T', kind: 'autosave', byte_size: 3, path: null, content: null }
    const { conn } = fakeConn(1, [row])
    const db = createDrizzle(conn)
    const rows = await db.select().from(revisions).orderBy(desc(revisions.createdAt))
    expect(rows).toEqual([{ id: 1, createdAt: 'T', kind: 'autosave', byteSize: 3, path: null, content: null }])
  })

  it('builds the plugin connection string for absolute paths', () => {
    expect(sqliteUrl('C:\\Books\\N\\index.sqlite')).toBe('sqlite:C:\\Books\\N\\index.sqlite')
  })
})
