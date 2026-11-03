import { describe, expect, it } from 'vitest'
import type { RecentProject } from '@/shared/store'
import { flagMissing, parseRecentFile, RECENT_LIMIT, samePath } from './recent'

// Adding/de-duplicating/capping is done by Rust (storage_remember_recent); see storage.rs tests.

const entry = (path: string, name = path, openedAt = '2026-01-01T00:00:00.000Z'): RecentProject => ({
  path,
  name,
  openedAt,
})

describe('recent projects list (read side)', () => {
  it('compares Windows paths case-insensitively', () => {
    expect(samePath('C:\\Books\\Novel', 'c:\\books\\novel\\')).toBe(true)
    expect(samePath('/home/A', '/home/a')).toBe(false)
    expect(samePath('/home/a/', '/home/a')).toBe(true)
  })

  it('flags and unflags missing entries', () => {
    const list = [entry('/a'), entry('/b')]
    const flagged = flagMissing(list, '/b', true)
    expect(flagged[1].missing).toBe(true)
    expect(flagged[0]).toEqual(entry('/a'))
    expect(flagMissing(flagged, '/b', false)[1]).toEqual(entry('/b'))
  })

  it('parses the Rust-written file', () => {
    const text = JSON.stringify({ version: 1, projects: [entry('/a'), entry('/b')] }, null, 2)
    expect(parseRecentFile(text)).toEqual([entry('/a'), entry('/b')])
  })

  it('tolerates missing, corrupt or odd files', () => {
    expect(parseRecentFile(null)).toEqual([])
    expect(parseRecentFile('')).toEqual([])
    expect(parseRecentFile('{not json')).toEqual([])
    expect(parseRecentFile('{"projects": 3}')).toEqual([])
    expect(
      parseRecentFile(
        JSON.stringify({ projects: [entry('/a'), { path: 5 }, null, entry('/a'), { path: '/c', name: 'c' }] }),
      ),
    ).toEqual([entry('/a')])
    const many = Array.from({ length: RECENT_LIMIT + 3 }, (_, i) => entry(`/p${i}`))
    expect(parseRecentFile(JSON.stringify({ projects: many }))).toHaveLength(RECENT_LIMIT)
  })
})
