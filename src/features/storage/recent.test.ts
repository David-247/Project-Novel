import { describe, expect, it } from 'vitest'
import type { RecentProject } from '@/shared/store'
import {
  addRecent,
  flagMissing,
  parseRecentFile,
  RECENT_LIMIT,
  removeRecent,
  samePath,
  serializeRecent,
} from './recent'

const entry = (path: string, name = path, openedAt = '2026-01-01T00:00:00.000Z'): RecentProject => ({
  path,
  name,
  openedAt,
})

describe('recent projects list', () => {
  it('puts the newest first and de-duplicates', () => {
    let list = addRecent([], entry('/a'))
    list = addRecent(list, entry('/b'))
    list = addRecent(list, entry('/a/', 'A again'))
    expect(list.map((r) => r.name)).toEqual(['A again', '/b'])
  })

  it('compares Windows paths case-insensitively', () => {
    expect(samePath('C:\\Books\\Novel', 'c:\\books\\novel\\')).toBe(true)
    expect(samePath('/home/A', '/home/a')).toBe(false)
    const list = addRecent([entry('C:\\Books\\Novel')], entry('c:\\books\\novel'))
    expect(list).toHaveLength(1)
  })

  it('is capped', () => {
    let list: RecentProject[] = []
    for (let i = 0; i < RECENT_LIMIT + 5; i++) list = addRecent(list, entry(`/p${i}`))
    expect(list).toHaveLength(RECENT_LIMIT)
    expect(list[0].path).toBe(`/p${RECENT_LIMIT + 4}`)
  })

  it('removes and flags entries', () => {
    const list = [entry('/a'), entry('/b')]
    expect(removeRecent(list, '/a')).toEqual([entry('/b')])
    const flagged = flagMissing(list, '/b', true)
    expect(flagged[1].missing).toBe(true)
    expect(flagMissing(flagged, '/b', false)[1]).toEqual(entry('/b'))
    // Re-opening clears the flag
    expect(addRecent(flagged, { ...entry('/b'), missing: true })[0].missing).toBeUndefined()
  })

  it('round-trips through the file format without the missing flag', () => {
    const list = [entry('/a'), { ...entry('/b'), missing: true }]
    const text = serializeRecent(list)
    expect(JSON.parse(text).version).toBe(1)
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
  })
})
