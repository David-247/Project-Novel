import type { RecentProject } from '@/shared/store'
import { trimTrailingSeparators } from './format'

/**
 * Recent-projects list, read side. The file is written only by Rust
 * (storage_remember_recent), so Open Recent cannot be pointed at arbitrary folders.
 */

/** Maximum number of entries kept in the recent-projects list (mirrors RECENT_LIMIT in storage.rs). */
export const RECENT_LIMIT = 10

/** Windows paths compare case-insensitively; others exactly. Trailing separators are ignored. */
export function normalizePath(path: string): string {
  const p = trimTrailingSeparators(path.trim())
  return /^[A-Za-z]:/.test(p) || p.startsWith('\\\\') ? p.replace(/\//g, '\\').toLowerCase() : p
}

export function samePath(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b)
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
