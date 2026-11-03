import type { RecentProject } from '@/shared/store'
import { trimTrailingSeparators } from './format'

/** Maximum number of entries kept in the recent-projects list. */
export const RECENT_LIMIT = 10
/** Version of recent-projects.json (in the app config dir). */
export const RECENT_FILE_VERSION = 1

/** Windows paths compare case-insensitively; others exactly. Trailing separators are ignored. */
export function normalizePath(path: string): string {
  const p = trimTrailingSeparators(path.trim())
  return /^[A-Za-z]:/.test(p) || p.startsWith('\\\\') ? p.replace(/\//g, '\\').toLowerCase() : p
}

export function samePath(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b)
}

/** Put `entry` first, removing any older entry for the same folder, capped at `limit`. */
export function addRecent(list: RecentProject[], entry: RecentProject, limit = RECENT_LIMIT): RecentProject[] {
  const fresh: RecentProject = { path: entry.path, name: entry.name, openedAt: entry.openedAt }
  return [fresh, ...list.filter((r) => !samePath(r.path, entry.path))].slice(0, limit)
}

export function removeRecent(list: RecentProject[], path: string): RecentProject[] {
  return list.filter((r) => !samePath(r.path, path))
}

/** Set or clear the `missing` flag of the entry for `path`. */
export function flagMissing(list: RecentProject[], path: string, missing: boolean): RecentProject[] {
  return list.map((r) => {
    if (!samePath(r.path, path)) return r
    const rest: RecentProject = { path: r.path, name: r.name, openedAt: r.openedAt }
    return missing ? { ...rest, missing: true } : rest
  })
}

/**
 * Parse recent-projects.json. Never throws: a missing or damaged file yields
 * an empty list, and invalid entries are dropped (the list is a convenience).
 */
export function parseRecentFile(text: string | null): RecentProject[] {
  if (!text) return []
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return []
  }
  const projects = (data as { projects?: unknown })?.projects
  if (!Array.isArray(projects)) return []
  let out: RecentProject[] = []
  for (const p of projects) {
    if (
      p &&
      typeof p === 'object' &&
      typeof p.path === 'string' &&
      p.path !== '' &&
      typeof p.name === 'string' &&
      typeof p.openedAt === 'string' &&
      !out.some((r) => samePath(r.path, p.path))
    ) {
      out = [...out, { path: p.path, name: p.name, openedAt: p.openedAt }]
    }
  }
  return out.slice(0, RECENT_LIMIT)
}

/** Serialize for disk; the transient `missing` flag is not persisted. */
export function serializeRecent(list: RecentProject[]): string {
  const projects = list.map(({ path, name, openedAt }) => ({ path, name, openedAt }))
  return JSON.stringify({ version: RECENT_FILE_VERSION, projects }, null, 2) + '\n'
}
