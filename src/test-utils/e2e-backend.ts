/**
 * E2E-ONLY fake Tauri backend for Playwright (never in the production bundle).
 *
 * Loaded by src/main.tsx only when the app is built with `vite build --mode e2e`
 * (`import.meta.env.MODE === 'e2e'` is replaced at build time, so a normal build
 * drops the dynamic import and this module is never emitted; `pnpm verify:prod-bundle`
 * checks that). It installs `window.__TAURI_INTERNALS__` via `@tauri-apps/api/mocks`
 * and answers every command through the shared command core (./fake-tauri-core.ts, the
 * same one Vitest uses), with IndexedDB persistence.
 *
 * Files persist in IndexedDB, so "force-kill" = closing the page without
 * beforeunload, and "relaunch" = a new page in the same browser context.
 * Native message dialogs are rendered as a DOM overlay (`data-testid="native-dialog"`)
 * so tests can read and answer them like a user. Tests drive the native File menu
 * and folder picker through `window.__nvE2E` (see e2e/helpers.ts).
 */
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { getEditor } from '@/features/editor'
import { getPaginationDebug, invalidatePagination, registerBottomReservation } from '@/features/pagination'
import { autosaveNow } from '@/features/storage'
import { useStore } from '@/shared/store'
import { auditTooltipCoverage, CONTROL_SELECTOR } from '@/features/tooltips'
import { canonical, createFakeTauriCore, type FakePersistence, type MessageDialogArgs, type PersistedRecord } from './fake-tauri-core'

/** Set by tests before the app boots (page.addInitScript). */
export interface E2EConfig {
  /** list_system_fonts fails (font enumeration error). */
  failFonts?: boolean
  /** Families list_system_fonts returns. */
  fonts?: string[]
}

// ---- IndexedDB persistence -------------------------------------------------

const DB_NAME = 'nv-e2e-fake-fs'
const STORE = 'entries'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'key' })
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function indexedDbPersistence(db: IDBDatabase): FakePersistence {
  /** Durable once resolved (the transaction committed), like an fsync'd write. */
  const write = (op: (store: IDBObjectStore) => void) =>
    new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite', { durability: 'strict' } as IDBTransactionOptions)
      op(tx.objectStore(STORE))
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  return {
    loadAll: () =>
      new Promise<PersistedRecord[]>((resolve, reject) => {
        const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll()
        req.onsuccess = () => resolve(req.result as PersistedRecord[])
        req.onerror = () => reject(req.error)
      }),
    put: (record) => write((s) => s.put(record)),
    delete: (key) => write((s) => s.delete(key)),
  }
}

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

function showNativeMessage(args: MessageDialogArgs): Promise<string> {
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

// ---- Install ---------------------------------------------------------------

/** Test control surface (window.__nvE2E). */
function controlFor(core: ReturnType<typeof createFakeTauriCore>) {
  const { state } = core
  return {
    /** Result of the next native folder dialog (null = cancelled). */
    setNextPick(path: string | null) {
      state.pick = path
    },
    /** Fire a Tauri event, e.g. a native File menu item ('menu://new-project'). */
    emit(event: string, payload?: unknown) {
      return window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event, payload })
    },
    /** Simulate write failures for paths containing `match` (null = stop). */
    setFailWrite(match: string | null, kind = 'disk_full') {
      state.failWrite =
        match === null ? null : (c: string) => (c.includes(match) ? { kind, message: `${c}: simulated ${kind}` } : null)
    },
    /** Slow disk: delay every file read by `ms`. */
    setReadDelay(ms: number) {
      state.readDelayMs = ms
    },
    writeFile: (path: string, contents: string) => core.seedFile(path, contents),
    readFile: (path: string) => state.files.get(canonical(path)) ?? null,
    listFiles: () => [...state.files.keys()].sort(),
    /** Add a folder to the Rust-owned recent list (as if opened before). */
    addRecent: (path: string, name: string) => core.seedRecent(path, name),
    recentMenu: () => state.menu,
    exits: () => state.exits,
    /** auditTooltipCoverage over the whole page incl. portals (the fake native dialog excluded). */
    auditTooltips: () =>
      auditTooltipCoverage(document.body)
        .filter((p) => !p.element.closest('[data-testid="native-dialog"]'))
        .map((p) => `${p.reason}: ${p.label}`),
    /** Number of controls the audit inspected (to prove it saw the UI). */
    countControls: () => document.body.querySelectorAll(CONTROL_SELECTOR).length,
    /** Take a crash-recovery snapshot now, as the 30 s autosave timer would (perf: autosave mid-typing). */
    autosaveNow: () => autosaveNow(),
    // ---- Pagination (Phase 2) ----
    /** The engine has laid out the current document and no reflow is pending. */
    paginationSettled: () => getPaginationDebug().settled,
    /** Px reserved at the bottom of each page. */
    paginationReserved: () => getPaginationDebug().reserved,
    /** The published layout model (store `layout` slice). */
    layout: () => {
      const l = useStore.getState().layout
      return {
        pageCount: l.pageCount,
        pages: l.pages,
        currentPage: l.currentPage,
        visibleSpread: l.visibleSpread,
        effectiveView: l.effectiveView,
        scale: l.scale,
        layoutVersion: l.layoutVersion,
      }
    },
    /** Book settings without the settings UI (owned by the book settings ticket). */
    setTrimSize: (id: string) => useStore.getState().bookActions.setTrimSize(id),
    setBookView: (view: 'spread' | 'single') => useStore.getState().bookActions.setView(view),
    /**
     * Emit `data-break-before` on top-level blocks, as style definitions will: `match` selects
     * blocks by node type (and heading level). Call with `null` to remove.
     */
    breakBeforeBlocks: (match: { type: string; level?: number } | null, value: 'page' | 'recto' = 'page') => {
      const ed = getEditor()
      if (!ed) return
      ed.unregisterPlugin(E2E_BREAK_KEY)
      if (match) {
        ed.registerPlugin(
          new Plugin({
            key: E2E_BREAK_KEY,
            props: {
              decorations: (state) => {
                const decos: Decoration[] = []
                state.doc.forEach((node, pos) => {
                  if (node.type.name === match.type && (match.level === undefined || node.attrs.level === match.level))
                    decos.push(Decoration.node(pos, pos + node.nodeSize, { 'data-break-before': value }))
                })
                return DecorationSet.create(state.doc, decos)
              },
            },
          }),
        )
      }
      invalidatePagination()
    },
    /** Reserve `px` at the bottom of every page whose range contains `pos` (footnote stand-in); null removes. */
    reserveBottom: (pos: number | null, px = 0) => {
      e2eReservation?.()
      e2eReservation = pos === null ? null : registerBottomReservation('e2e', (p) => (p.from <= pos && pos < p.to ? px : 0))
    },
  }
}

const E2E_BREAK_KEY = new PluginKey('e2e-break-before')
let e2eReservation: (() => void) | null = null

declare global {
  interface Window {
    __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> }
    __nvE2E: ReturnType<typeof controlFor>
    __nvE2EConfig?: E2EConfig
  }
}

export async function installE2EBackend(): Promise<void> {
  const core = createFakeTauriCore({
    persistence: indexedDbPersistence(await openDb()),
    messageDialog: showNativeMessage,
    pickOnce: true,
    pickCreatesFolder: true,
  })
  await core.hydrate()
  const config = window.__nvE2EConfig ?? {}
  core.state.failFonts = !!config.failFonts
  if (config.fonts) core.state.fonts = config.fonts
  mockWindows('main')
  mockIPC(
    async (cmd, args) => {
      try {
        return await core.handle(cmd, (args ?? {}) as Record<string, unknown>)
      } catch (e) {
        if (e instanceof Error && e.message.startsWith('unexpected command')) {
          console.error(`[e2e-backend] unhandled command ${cmd}`, args)
        }
        throw e
      }
    },
    { shouldMockEvents: true },
  )
  ;(globalThis as unknown as { isTauri: boolean }).isTauri = true
  window.__nvE2E = controlFor(core)
}
