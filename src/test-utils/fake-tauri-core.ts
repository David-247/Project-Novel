/**
 * TEST-ONLY in-memory stand-in for the Tauri backend: the Rust storage commands (src-tauri/src/storage.rs),
 * list_system_fonts, and the plugin commands the app uses (dialog message, SQL, window theme/destroy).
 * One command core, shared by:
 *   - Vitest: src/test-utils/fake-tauri.ts (module mocks; Map persistence),
 *   - Playwright: src/test-utils/e2e-backend.ts (mockIPC; IndexedDB persistence, e2e builds only).
 * It mirrors Rust's rules: root confinement (only a folder picked in the native dialog or listed in the
 * Rust-owned recent list can become the root), `..` refusal for existence checks, the recent list
 * written only here, the startup recovery probe. Paths are POSIX-style.
 *
 * The working set lives in memory (`state`); every change is written through to a persistence
 * adapter, from which a new core can be hydrated ("relaunch" over the same disk).
 */

export interface RecentEntry {
  path: string
  name: string
  openedAt: string
}

/** Error shape thrown like Rust's StorageError. */
export interface FakeError {
  kind: string
  message: string
}

/** One persisted entry: a file, a folder, or core metadata (recent list, SQL user_version). */
export interface PersistedRecord {
  key: string
  kind: 'file' | 'dir' | 'meta'
  value: string
}

/** Where the fake disk is kept between "launches". */
export interface FakePersistence {
  /** Every record (hydration). */
  loadAll(): Promise<PersistedRecord[]>
  put(record: PersistedRecord): Promise<void>
  delete(key: string): Promise<void>
}

/** Map-backed persistence (Vitest, and anything that needs no durable storage). */
export function memoryPersistence(map = new Map<string, PersistedRecord>()): FakePersistence & {
  records: Map<string, PersistedRecord>
} {
  return {
    records: map,
    loadAll: async () => [...map.values()],
    put: async (r) => void map.set(r.key, r),
    delete: async (key) => void map.delete(key),
  }
}

/** Arguments of `plugin:dialog|message` (as @tauri-apps/plugin-dialog sends them). */
export interface MessageDialogArgs {
  message: string
  title?: string
  kind?: string
  buttons?: unknown
  [k: string]: unknown
}

export interface FakeCoreOptions {
  persistence?: FakePersistence
  /** Answers a native message box with the label of the chosen button. */
  messageDialog?: (args: MessageDialogArgs) => Promise<string>
  /**
   * true: the native folder dialog answers `pick` once and then reverts to "cancelled" (e2e:
   * `setNextPick`); false: `pick` sticks until changed (Vitest: `backend.pick = ...`).
   */
  pickOnce?: boolean
  /** true: a picked folder is created if missing (the native dialog can create folders). */
  pickCreatesFolder?: boolean
}

/**
 * Every command name the core answers. Frontend invokes outside this list fail the
 * `fake-tauri-core.test.ts` coverage check.
 */
export const HANDLED_COMMANDS = [
  'storage_pick_project_folder',
  'storage_open_recent_root',
  'storage_restore_project_root',
  'storage_clear_project_root',
  'storage_write_file_atomic',
  'storage_read_text_file',
  'storage_path_exists',
  'storage_ensure_dir',
  'storage_remove_file',
  'storage_read_recent',
  'storage_remember_recent',
  'storage_set_recent_menu',
  'storage_exit_app',
  'storage_probe_recent_recovery',
  'storage_list_dir',
  'list_system_fonts',
  'plugin:dialog|message',
  'plugin:sql|load',
  'plugin:sql|execute',
  'plugin:sql|select',
  'plugin:sql|close',
  'plugin:window|theme',
  'plugin:window|destroy',
] as const

const notFound = (p: string): FakeError => ({ kind: 'not_found', message: `${p}: not found` })
const outside = (p: string): FakeError => ({ kind: 'outside_project', message: `${p} is outside the open project folder` })

/** Resolve `.` and `..` like fs::canonicalize (no symlinks here). */
export function canonical(p: string): string {
  const out: string[] = []
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return '/' + out.join('/')
}

export const parentOf = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/'

export type FakeTauriCore = ReturnType<typeof createFakeTauriCore>

export function createFakeTauriCore(options: FakeCoreOptions = {}) {
  const persistence = options.persistence ?? memoryPersistence()
  const persist = {
    file: (path: string, value: string) => persistence.put({ key: `file:${path}`, kind: 'file', value }),
    removeFile: (path: string) => persistence.delete(`file:${path}`),
    dir: (path: string) => persistence.put({ key: `dir:${path}`, kind: 'dir', value: path }),
    meta: (name: string, value: unknown) =>
      persistence.put({ key: `meta:${name}`, kind: 'meta', value: JSON.stringify(value) }),
  }

  const state = {
    files: new Map<string, string>(),
    dirs: new Set<string>(),
    /** Paths written by storage_write_file_atomic, in order. */
    writes: [] as string[],
    active: null as string | null,
    previous: null as string | null,
    recent: [] as RecentEntry[],
    menu: [] as unknown[],
    /** Result of the native folder dialog (null = cancelled); see `pickOnce`. */
    pick: null as string | null,
    exits: 0,
    windowDestroys: 0,
    /** Consulted before every write/mkdir/remove; a returned error is thrown like Rust's. */
    failWrite: null as null | ((path: string) => FakeError | null),
    failRead: null as null | ((path: string) => FakeError | null),
    /** Awaited inside storage_write_file_atomic (to hold a write in flight). */
    writeGate: null as null | ((path: string) => Promise<void>),
    /** Slow disk: every file read waits this long. */
    readDelayMs: 0,
    /** list_system_fonts answer, or a failure. */
    fonts: ['E2E Serif', 'E2E Sans'] as string[],
    failFonts: false,
    /** SQL plugin: pools by connection URL (load replaces, close closes whatever the URL has now). */
    sqlPools: new Map<string, { closed: boolean }>(),
    sqlVersions: new Map<string, number>(),
    sqlExecuted: [] as string[],
    sqlLoads: [] as string[],
    failSqlLoad: false,
  }

  function reset(): void {
    state.files.clear()
    state.dirs.clear()
    state.writes.length = 0
    state.active = state.previous = null
    state.recent = []
    state.menu = []
    state.pick = null
    state.exits = 0
    state.windowDestroys = 0
    state.failWrite = null
    state.failRead = null
    state.writeGate = null
    state.readDelayMs = 0
    state.fonts = ['E2E Serif', 'E2E Sans']
    state.failFonts = false
    state.sqlPools.clear()
    state.sqlVersions.clear()
    state.sqlExecuted.length = 0
    state.sqlLoads.length = 0
    state.failSqlLoad = false
  }

  /** Load the persisted disk into memory (a "relaunch" over the same files). */
  async function hydrate(): Promise<void> {
    for (const r of await persistence.loadAll()) {
      if (r.kind === 'file') state.files.set(r.key.slice('file:'.length), r.value)
      else if (r.kind === 'dir') state.dirs.add(r.value)
      else if (r.key === 'meta:recent') state.recent = JSON.parse(r.value) as RecentEntry[]
      else if (r.key === 'meta:sql') {
        for (const [k, v] of JSON.parse(r.value) as [string, number][]) state.sqlVersions.set(k, v)
      }
    }
  }

  function grant(path: string) {
    state.previous = state.active
    state.active = canonical(path)
  }

  function confined(path: string, forWrite: boolean): string {
    const root = state.active
    if (!root) throw { kind: 'outside_project', message: 'No project folder is open' }
    const c = canonical(path)
    const dir = forWrite ? parentOf(c) : c
    if (forWrite && !state.dirs.has(dir)) throw notFound(dir)
    if (dir !== root && !dir.startsWith(root + '/')) throw outside(path)
    return c
  }

  function checkWrite(c: string) {
    const err = state.failWrite?.(c)
    if (err) throw err
  }

  function isRecent(c: string): boolean {
    return state.recent.some((r) => canonical(r.path) === c)
  }

  const recentJSON = () => JSON.stringify({ version: 1, projects: state.recent }, null, 2)

  /** Create `path` and its ancestors (a folder the native dialog created, or test setup). */
  async function ensureFolderExists(path: string) {
    const parts = canonical(path).split('/').filter(Boolean)
    for (let i = 1; i <= parts.length; i++) {
      const d = '/' + parts.slice(0, i).join('/')
      if (!state.dirs.has(d)) {
        state.dirs.add(d)
        await persist.dir(d)
      }
    }
  }

  /** Test setup: write a file anywhere (creating folders), bypassing confinement. */
  async function seedFile(path: string, contents: string) {
    const c = canonical(path)
    await ensureFolderExists(parentOf(c))
    state.files.set(c, contents)
    await persist.file(c, contents)
  }

  /** Test setup: list a folder in the Rust-owned recent list (as if opened before). */
  async function seedRecent(path: string, name: string) {
    state.recent = [
      { path: canonical(path), name, openedAt: new Date().toISOString() },
      ...state.recent.filter((r) => canonical(r.path) !== canonical(path)),
    ]
    await persist.meta('recent', state.recent)
  }

  function sqlPool(db: string) {
    const pool = state.sqlPools.get(db)
    if (!pool || pool.closed) throw new Error(`database ${db} is closed`)
    return pool
  }

  async function handle(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const path = args.path as string
    switch (cmd) {
      case 'list_system_fonts':
        if (state.failFonts) throw new Error('font enumeration failed')
        return state.fonts

      case 'storage_pick_project_folder': {
        const pick = state.pick
        if (options.pickOnce) state.pick = null
        if (pick) {
          if (options.pickCreatesFolder) await ensureFolderExists(pick)
          grant(pick)
        }
        return pick
      }
      case 'storage_open_recent_root':
        if (!state.dirs.has(canonical(path))) throw notFound(path)
        if (!isRecent(canonical(path))) throw { kind: 'not_recent', message: `${path} is not in the recent projects list` }
        grant(path)
        return null
      case 'storage_restore_project_root':
        state.active = state.previous
        state.previous = null
        return null
      case 'storage_clear_project_root':
        state.active = state.previous = null
        return null

      case 'storage_path_exists': {
        // Only inside the active root or a recent-list folder; no `..`.
        if (path.split('/').includes('..')) throw { kind: 'invalid_path', message: "Path may not contain '..'" }
        const c = canonical(path)
        const roots = [state.active, ...state.recent.map((r) => canonical(r.path))].filter(Boolean) as string[]
        if (!roots.some((r) => c === r || c.startsWith(r + '/'))) throw outside(path)
        return state.files.has(c) || state.dirs.has(c)
      }
      case 'storage_probe_recent_recovery': {
        const c = canonical(path)
        if (!state.dirs.has(c)) throw notFound(path)
        if (!isRecent(c)) throw { kind: 'not_recent', message: `${path} is not in the recent projects list` }
        return {
          project: state.files.get(`${c}/project.json`) ?? null,
          recovery: state.files.get(`${c}/.recovery/manuscript.json`) ?? null,
        }
      }
      case 'storage_exit_app':
        state.exits++
        return null

      case 'storage_read_text_file': {
        const c = confined(path, false)
        const readErr = state.failRead?.(c)
        if (readErr) throw readErr
        if (state.readDelayMs) await new Promise((r) => setTimeout(r, state.readDelayMs))
        if (!state.files.has(c)) throw notFound(path)
        return state.files.get(c)
      }
      case 'storage_write_file_atomic': {
        const c = confined(path, true)
        checkWrite(c)
        if (state.writeGate) await state.writeGate(c)
        state.files.set(c, args.contents as string)
        state.writes.push(c)
        await persist.file(c, args.contents as string)
        return null
      }
      case 'storage_ensure_dir': {
        const c = confined(path, true)
        checkWrite(c)
        if (state.files.has(c)) throw { kind: 'invalid_path', message: `Not a folder: ${path}` }
        state.dirs.add(c)
        await persist.dir(c)
        return null
      }
      case 'storage_remove_file': {
        let c: string
        try {
          c = confined(path, true)
        } catch (e) {
          // The parent folder does not exist, so neither does the file.
          if ((e as FakeError).kind === 'not_found') return false
          throw e
        }
        checkWrite(c)
        const existed = state.files.delete(c)
        await persist.removeFile(c)
        return existed
      }
      case 'storage_list_dir': {
        const c = confined(path, false)
        if (state.files.has(c)) throw { kind: 'invalid_path', message: `Not a folder: ${path}` }
        return [...state.files.keys()]
          .filter((f) => parentOf(f) === c)
          .map((f) => f.slice(c.length + 1))
          .sort()
      }

      case 'storage_read_recent':
        return state.recent.length ? recentJSON() : null
      case 'storage_remember_recent': {
        const root = state.active
        if (!root) throw { kind: 'outside_project', message: 'No project folder is open' }
        state.recent = [
          { path: root, name: args.name as string, openedAt: args.openedAt as string },
          ...state.recent.filter((r) => canonical(r.path) !== root),
        ].slice(0, 10)
        await persist.meta('recent', state.recent)
        return recentJSON()
      }
      case 'storage_set_recent_menu':
        state.menu = args.entries as unknown[]
        return null

      case 'plugin:dialog|message':
        if (!options.messageDialog) throw new Error('no message dialog in this fake')
        return options.messageDialog(args as MessageDialogArgs)

      case 'plugin:sql|load': {
        const db = args.db as string
        if (state.failSqlLoad) throw new Error('sqlite unavailable')
        state.sqlLoads.push(db)
        state.sqlPools.set(db, { closed: false })
        return db
      }
      case 'plugin:sql|execute': {
        const db = args.db as string
        const query = args.query as string
        sqlPool(db)
        state.sqlExecuted.push(query)
        const m = /PRAGMA\s+user_version\s*=\s*(\d+)/i.exec(query)
        if (m) {
          state.sqlVersions.set(db, Number(m[1]))
          await persist.meta('sql', [...state.sqlVersions])
        }
        return [1, 0]
      }
      case 'plugin:sql|select': {
        const db = args.db as string
        sqlPool(db)
        if (/PRAGMA\s+user_version/i.test(args.query as string)) {
          return [{ user_version: state.sqlVersions.get(db) ?? 0 }]
        }
        return []
      }
      case 'plugin:sql|close': {
        const db = args.db as string | undefined
        for (const [url, pool] of state.sqlPools) {
          if (db === undefined || url === db) {
            pool.closed = true
            state.sqlPools.delete(url)
          }
        }
        return true
      }

      case 'plugin:window|theme':
        // null: the app follows prefers-color-scheme.
        return null
      case 'plugin:window|destroy':
        state.windowDestroys++
        return null

      default:
        throw new Error(`unexpected command ${cmd}`)
    }
  }

  return { state, handle, reset, hydrate, seedFile, seedRecent, ensureFolderExists }
}
