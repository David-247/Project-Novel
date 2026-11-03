/**
 * In-memory stand-in for the Rust storage commands, the dialog plugin and the
 * SQL plugin, mirroring their semantics (root confinement, Rust-owned recent
 * list). Test-only. Paths are POSIX-style.
 *
 *   vi.mock('@tauri-apps/api/core', async () => (await import('@/test-utils/fake-tauri')).coreModule)
 *   vi.mock('@tauri-apps/plugin-dialog', async () => (await import('@/test-utils/fake-tauri')).dialogModule)
 *   vi.mock('@tauri-apps/plugin-sql', async () => (await import('@/test-utils/fake-tauri')).sqlModule)
 */

interface RecentEntry {
  path: string
  name: string
  openedAt: string
}

export const backend = {
  files: new Map<string, string>(),
  dirs: new Set<string>(),
  writes: [] as string[],
  active: null as string | null,
  previous: null as string | null,
  recent: [] as RecentEntry[],
  menu: [] as unknown[],
  /** Result of the next native folder dialog (null = cancelled). */
  pick: null as string | null,
  messages: [] as { text: string; opts: unknown }[],
  /** Button result of the next message dialog. */
  answer: 'Cancel' as string,
  sqlExecuted: [] as string[],
  sqlLoads: [] as string[],
  failSqlLoad: false,
  /** If set, consulted before every write/mkdir/remove; a returned error is thrown like Rust's. */
  failWrite: null as null | ((path: string) => { kind: string; message: string } | null),
  /** Optional hook awaited inside storage_write_file_atomic (to hold a write in flight). */
  writeGate: null as null | ((path: string) => Promise<void>),
  reset() {
    this.files.clear()
    this.dirs.clear()
    this.writes.length = 0
    this.active = null
    this.previous = null
    this.recent = []
    this.menu = []
    this.pick = null
    this.messages.length = 0
    this.answer = 'Cancel'
    this.sqlExecuted.length = 0
    this.sqlLoads.length = 0
    this.failSqlLoad = false
    this.failWrite = null
    this.writeGate = null
  },
}

const notFound = (p: string) => ({ kind: 'not_found', message: `${p}: not found` })

/** Resolve `.` and `..` like fs::canonicalize (no symlinks here). */
function canonical(p: string): string {
  const out: string[] = []
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return '/' + out.join('/')
}

const parent = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/'

function grant(path: string) {
  backend.previous = backend.active
  backend.active = canonical(path)
}

function confined(path: string, forWrite: boolean): string {
  if (!backend.active) throw { kind: 'outside_project', message: 'No project folder is open' }
  const c = canonical(path)
  const dir = forWrite ? parent(c) : c
  if (forWrite && !backend.dirs.has(dir)) throw notFound(dir)
  if (dir !== backend.active && !dir.startsWith(backend.active + '/')) {
    throw { kind: 'outside_project', message: `${path} is outside the open project folder` }
  }
  return c
}

const recentJSON = () => JSON.stringify({ version: 1, projects: backend.recent }, null, 2)

export async function invokeMock(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const path = args.path as string
  switch (cmd) {
    case 'storage_pick_project_folder':
      if (backend.pick) grant(backend.pick)
      return backend.pick
    case 'storage_open_recent_root':
      if (!backend.dirs.has(canonical(path))) throw notFound(path)
      if (!backend.recent.some((r) => canonical(r.path) === canonical(path))) {
        throw { kind: 'not_recent', message: `${path} is not in the recent projects list` }
      }
      grant(path)
      return null
    case 'storage_restore_project_root':
      backend.active = backend.previous
      backend.previous = null
      return null
    case 'storage_clear_project_root':
      backend.active = backend.previous = null
      return null
    case 'storage_path_exists':
      return backend.files.has(canonical(path)) || backend.dirs.has(canonical(path))
    case 'storage_read_text_file': {
      const c = confined(path, false)
      if (!backend.files.has(c)) throw notFound(path)
      return backend.files.get(c)
    }
    case 'storage_write_file_atomic': {
      const c = confined(path, true)
      const err = backend.failWrite?.(c)
      if (err) throw err
      if (backend.writeGate) await backend.writeGate(c)
      backend.files.set(c, args.contents as string)
      backend.writes.push(c)
      return null
    }
    case 'storage_ensure_dir': {
      const c = confined(path, true)
      const err = backend.failWrite?.(c)
      if (err) throw err
      if (backend.files.has(c)) throw { kind: 'invalid_path', message: `Not a folder: ${path}` }
      backend.dirs.add(c)
      return null
    }
    case 'storage_remove_file': {
      let c: string
      try {
        c = confined(path, true)
      } catch (e) {
        if ((e as { kind?: string }).kind === 'not_found') return false
        throw e
      }
      const err = backend.failWrite?.(c)
      if (err) throw err
      return backend.files.delete(c)
    }
    case 'storage_read_recent':
      return backend.recent.length ? recentJSON() : null
    case 'storage_remember_recent': {
      const root = backend.active
      if (!root) throw { kind: 'outside_project', message: 'No project folder is open' }
      backend.recent = [
        { path: root, name: args.name as string, openedAt: args.openedAt as string },
        ...backend.recent.filter((r) => canonical(r.path) !== root),
      ].slice(0, 10)
      return recentJSON()
    }
    case 'storage_set_recent_menu':
      backend.menu = args.entries as unknown[]
      return null
    default:
      throw new Error(`unexpected command ${cmd}`)
  }
}

export const coreModule = { isTauri: () => true, invoke: invokeMock }

export const dialogModule = {
  message: async (text: string, opts: unknown) => {
    backend.messages.push({ text, opts })
    return backend.answer
  },
}

export const sqlModule = {
  default: {
    load: async (url: string) => {
      if (backend.failSqlLoad) throw new Error('sqlite unavailable')
      backend.sqlLoads.push(url)
      return {
        execute: async (q: string) => {
          backend.sqlExecuted.push(q)
          return { rowsAffected: 1 }
        },
        select: async () => [{ user_version: 0 }],
        close: async () => true,
      }
    },
  },
}
