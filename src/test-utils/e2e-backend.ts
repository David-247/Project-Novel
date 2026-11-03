/**
 * E2E-ONLY fake Tauri backend for Playwright (never in the production bundle).
 *
 * Loaded by src/main.tsx only when the app is built with `vite build --mode e2e`
 * (`import.meta.env.MODE === 'e2e'` is replaced at build time, so a normal build
 * drops the dynamic import and this module is never emitted; `pnpm verify:prod-bundle`
 * checks that). It installs `window.__TAURI_INTERNALS__` via `@tauri-apps/api/mocks`
 * and answers the same commands as src-tauri (storage_*, list_system_fonts,
 * plugin:dialog|message, plugin:sql|*, events), mirroring src/test-utils/fake-tauri.ts.
 *
 * Files persist in IndexedDB, so "force-kill" = closing the page without
 * beforeunload, and "relaunch" = a new page in the same browser context.
 * Native message dialogs are rendered as a DOM overlay (`data-testid="native-dialog"`)
 * so tests can read and answer them like a user. Tests drive the native File menu
 * and folder picker through `window.__nvE2E` (see e2e/helpers.ts).
 */
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks'
import { auditTooltipCoverage, CONTROL_SELECTOR } from '@/features/tooltips'

interface RecentEntry {
  path: string
  name: string
  openedAt: string
}

/** Set by tests before the app boots (page.addInitScript). */
export interface E2EConfig {
  /** list_system_fonts fails (font enumeration error). */
  failFonts?: boolean
  /** Families list_system_fonts returns. */
  fonts?: string[]
}

type StoredKind = 'file' | 'dir' | 'meta'
interface StoredRecord {
  key: string
  kind: StoredKind
  value: string
}

const DB_NAME = 'nv-e2e-fake-fs'
const STORE = 'entries'

const files = new Map<string, string>()
const dirs = new Set<string>()
let recent: RecentEntry[] = []
const sqlVersions = new Map<string, number>()
let active: string | null = null
let previous: string | null = null
let nextPick: string | null = null
let failWrite: { match: string; kind: string } | null = null
let readDelayMs = 0
let menuEntries: unknown[] = []
let exits = 0
const config = (): E2EConfig => (window as unknown as { __nvE2EConfig?: E2EConfig }).__nvE2EConfig ?? {}

// ---- IndexedDB persistence -------------------------------------------------

let db: IDBDatabase | null = null

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'key' })
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/** Durable once resolved (the transaction committed), like an fsync'd write. */
function persist(op: (store: IDBObjectStore) => void): Promise<void> {
  if (!db) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const tx = db!.transaction(STORE, 'readwrite', { durability: 'strict' } as IDBTransactionOptions)
    op(tx.objectStore(STORE))
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

const putFile = (path: string, value: string) => persist((s) => s.put({ key: `file:${path}`, kind: 'file', value }))
const putDir = (path: string) => persist((s) => s.put({ key: `dir:${path}`, kind: 'dir', value: path }))
const putMeta = (name: string, value: unknown) =>
  persist((s) => s.put({ key: `meta:${name}`, kind: 'meta', value: JSON.stringify(value) }))

async function loadAll(): Promise<void> {
  db = await openDb()
  const records = await new Promise<StoredRecord[]>((resolve, reject) => {
    const req = db!.transaction(STORE, 'readonly').objectStore(STORE).getAll()
    req.onsuccess = () => resolve(req.result as StoredRecord[])
    req.onerror = () => reject(req.error)
  })
  for (const r of records) {
    if (r.kind === 'file') files.set(r.key.slice('file:'.length), r.value)
    else if (r.kind === 'dir') dirs.add(r.value)
    else if (r.key === 'meta:recent') recent = JSON.parse(r.value) as RecentEntry[]
    else if (r.key === 'meta:sql') for (const [k, v] of JSON.parse(r.value) as [string, number][]) sqlVersions.set(k, v)
  }
}

// ---- Path rules (mirror src-tauri/src/storage.rs) --------------------------

const notFound = (p: string) => ({ kind: 'not_found', message: `${p}: not found` })

function canonical(p: string): string {
  const out: string[] = []
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return '/' + out.join('/')
}

const parentOf = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/'

function grant(path: string) {
  previous = active
  active = canonical(path)
}

function confined(path: string, forWrite: boolean): string {
  if (!active) throw { kind: 'outside_project', message: 'No project folder is open' }
  const c = canonical(path)
  const dir = forWrite ? parentOf(c) : c
  if (forWrite && !dirs.has(dir)) throw notFound(dir)
  if (dir !== active && !dir.startsWith(active + '/')) {
    throw { kind: 'outside_project', message: `${path} is outside the open project folder` }
  }
  return c
}

function checkWrite(c: string) {
  if (failWrite && c.includes(failWrite.match)) {
    throw { kind: failWrite.kind, message: `${c}: simulated ${failWrite.kind}` }
  }
}

/** A picked folder exists on disk (the native dialog can create it). */
async function ensureFolderExists(path: string) {
  const c = canonical(path)
  const parts = c.split('/').filter(Boolean)
  for (let i = 1; i <= parts.length; i++) {
    const d = '/' + parts.slice(0, i).join('/')
    if (!dirs.has(d)) {
      dirs.add(d)
      await putDir(d)
    }
  }
}

const recentJSON = () => JSON.stringify({ version: 1, projects: recent }, null, 2)

// ---- Native message dialog (DOM stand-in) ----------------------------------

function buttonLabels(buttons: unknown): string[] {
  if (!buttons) return ['OK']
  if (typeof buttons === 'string') return buttons === 'OkCancel' ? ['OK', 'Cancel'] : buttons === 'YesNo' ? ['Yes', 'No'] : ['OK']
  const b = buttons as Record<string, string | string[]>
  if (b.OkCustom) return [b.OkCustom as string]
  if (b.OkCancelCustom) return b.OkCancelCustom as string[]
  if (b.YesNoCancelCustom) return b.YesNoCancelCustom as string[]
  return ['OK']
}

function showNativeMessage(args: { message: string; title?: string; kind?: string; buttons?: unknown }): Promise<string> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.dataset.testid = 'native-dialog'
    overlay.dataset.kind = args.kind ?? 'info'
    overlay.setAttribute('role', 'alertdialog')
    overlay.setAttribute('aria-label', args.title ?? 'Message')
    overlay.style.cssText =
      'position:fixed;inset:auto 16px 16px auto;z-index:2147483647;max-width:420px;padding:12px;' +
      'background:#fff;color:#000;border:2px solid #000;font:14px system-ui'
    const title = document.createElement('strong')
    title.textContent = args.title ?? ''
    const text = document.createElement('p')
    text.dataset.testid = 'native-dialog-message'
    text.textContent = args.message
    overlay.append(title, text)
    for (const label of buttonLabels(args.buttons)) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.textContent = label
      btn.onclick = () => {
        overlay.remove()
        resolve(label)
      }
      overlay.append(btn)
    }
    document.body.append(overlay)
  })
}

// ---- Command handler -------------------------------------------------------

async function handle(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const path = args.path as string
  switch (cmd) {
    case 'list_system_fonts':
      if (config().failFonts) throw new Error('font enumeration failed')
      return config().fonts ?? ['E2E Serif', 'E2E Sans']
    case 'storage_pick_project_folder': {
      const pick = nextPick
      nextPick = null
      if (pick) {
        await ensureFolderExists(pick)
        grant(pick)
      }
      return pick
    }
    case 'storage_open_recent_root':
      if (!dirs.has(canonical(path))) throw notFound(path)
      if (!recent.some((r) => canonical(r.path) === canonical(path))) {
        throw { kind: 'not_recent', message: `${path} is not in the recent projects list` }
      }
      grant(path)
      return null
    case 'storage_restore_project_root':
      active = previous
      previous = null
      return null
    case 'storage_clear_project_root':
      active = previous = null
      return null
    case 'storage_path_exists': {
      if (path.split('/').includes('..')) throw { kind: 'invalid_path', message: "Path may not contain '..'" }
      const c = canonical(path)
      const roots = [active, ...recent.map((r) => canonical(r.path))].filter(Boolean) as string[]
      if (!roots.some((r) => c === r || c.startsWith(r + '/'))) {
        throw { kind: 'outside_project', message: `${path} is outside the open project folder` }
      }
      return files.has(c) || dirs.has(c)
    }
    case 'storage_exit_app':
      exits++
      return null
    case 'storage_read_text_file': {
      const c = confined(path, false)
      if (readDelayMs) await new Promise((r) => setTimeout(r, readDelayMs))
      if (!files.has(c)) throw notFound(path)
      return files.get(c)
    }
    case 'storage_write_file_atomic': {
      const c = confined(path, true)
      checkWrite(c)
      files.set(c, args.contents as string)
      await putFile(c, args.contents as string)
      return null
    }
    case 'storage_ensure_dir': {
      const c = confined(path, true)
      checkWrite(c)
      if (files.has(c)) throw { kind: 'invalid_path', message: `Not a folder: ${path}` }
      dirs.add(c)
      await putDir(c)
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
      checkWrite(c)
      const existed = files.delete(c)
      await persist((s) => s.delete(`file:${c}`))
      return existed
    }
    case 'storage_read_recent':
      return recent.length ? recentJSON() : null
    case 'storage_remember_recent': {
      const root = active
      if (!root) throw { kind: 'outside_project', message: 'No project folder is open' }
      recent = [
        { path: root, name: args.name as string, openedAt: args.openedAt as string },
        ...recent.filter((r) => canonical(r.path) !== root),
      ].slice(0, 10)
      await putMeta('recent', recent)
      return recentJSON()
    }
    case 'storage_set_recent_menu':
      menuEntries = args.entries as unknown[]
      return null
    case 'plugin:dialog|message':
      return showNativeMessage(args as never)
    case 'plugin:sql|load':
      return args.db
    case 'plugin:sql|execute': {
      const m = /PRAGMA\s+user_version\s*=\s*(\d+)/i.exec(args.query as string)
      if (m) {
        sqlVersions.set(args.db as string, Number(m[1]))
        await putMeta('sql', [...sqlVersions])
      }
      return [1, 0]
    }
    case 'plugin:sql|select':
      if (/PRAGMA\s+user_version/i.test(args.query as string)) {
        return [{ user_version: sqlVersions.get(args.db as string) ?? 0 }]
      }
      return []
    case 'plugin:sql|close':
      return true
    case 'plugin:window|theme':
      // null: the app follows prefers-color-scheme (emulated by Playwright).
      return null
    case 'plugin:window|destroy':
      return null
    default:
      console.error(`[e2e-backend] unhandled command ${cmd}`, args)
      throw new Error(`unexpected command ${cmd}`)
  }
}

/** Test control surface (window.__nvE2E). */
const control = {
  /** Result of the next native folder dialog (null = cancelled). */
  setNextPick(path: string | null) {
    nextPick = path
  },
  /** Fire a Tauri event, e.g. a native File menu item ('menu://new-project'). */
  emit(event: string, payload?: unknown) {
    return window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event, payload })
  },
  /** Simulate write failures for paths containing `match` (null = stop). */
  setFailWrite(match: string | null, kind = 'disk_full') {
    failWrite = match === null ? null : { match, kind }
  },
  /** Slow disk: delay every file read by `ms`. */
  setReadDelay(ms: number) {
    readDelayMs = ms
  },
  async writeFile(path: string, contents: string) {
    const c = canonical(path)
    await ensureFolderExists(parentOf(c))
    files.set(c, contents)
    await putFile(c, contents)
  },
  readFile: (path: string) => files.get(canonical(path)) ?? null,
  listFiles: () => [...files.keys()].sort(),
  /** Add a folder to the Rust-owned recent list (as if opened before). */
  async addRecent(path: string, name: string) {
    recent = [{ path: canonical(path), name, openedAt: new Date().toISOString() }, ...recent]
    await putMeta('recent', recent)
  },
  recentMenu: () => menuEntries,
  exits: () => exits,
  /** auditTooltipCoverage over the whole page incl. portals (the fake native dialog excluded). */
  auditTooltips: () =>
    auditTooltipCoverage(document.body)
      .filter((p) => !p.element.closest('[data-testid="native-dialog"]'))
      .map((p) => `${p.reason}: ${p.label}`),
  /** Number of controls the audit inspected (to prove it saw the UI). */
  countControls: () => document.body.querySelectorAll(CONTROL_SELECTOR).length,
}

declare global {
  interface Window {
    __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> }
    __nvE2E: typeof control
  }
}

export async function installE2EBackend(): Promise<void> {
  await loadAll()
  mockWindows('main')
  mockIPC((cmd, args) => handle(cmd, (args ?? {}) as Record<string, unknown>), { shouldMockEvents: true })
  ;(globalThis as unknown as { isTauri: boolean }).isTauri = true
  window.__nvE2E = control
}
