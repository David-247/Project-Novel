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
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { getDocJSON, getEditor, getFootnotes, getResolvedStyles, setDocJSON } from '@/features/editor'
import {
  applyPreset,
  buildManuscript,
  createDocxRenderer,
  defaultManuscriptSettings,
  getWizardState,
  isAbortError,
  manuscriptWordCount,
  WIZARD_FIXTURE_COMMENTS,
  WIZARD_FIXTURE_DOC,
  WIZARD_FIXTURE_REWRITES,
  WIZARD_FIXTURE_STYLES,
} from '@/features/export'
import { acceptAll, countChanges, rejectAll, setMarkupView, setTracking } from '@/features/track-changes'
import { isBlockHidden, isInlineHidden, type MarkupView } from '@/shared/track-changes'
import { getPaginationDebug, invalidatePagination, registerBottomReservation, relayoutPagination, revealPosition, turnSpread, goToEdgeSpread, showPage } from '@/features/pagination'
import { ensureAuthorName } from '@/features/settings'
import { autosaveNow } from '@/features/storage'
import { commentsDebug } from '@/features/comments'
import { rewriteDebug } from '@/features/rewrite'
import { outlineDebug } from '@/features/outline'
import { footnoteAreaHeights, footnotePlacement } from '@/features/footnotes'
import { useStore } from '@/shared/store'
import { getCommands, runCommand } from '@/shared/commands'
import { formatShortcut } from '@/shared/ui'
import { auditTooltipCoverage, CONTROL_SELECTOR } from '@/features/tooltips'
import { canonical, createFakeTauriCore, type FakePersistence, type MessageDialogArgs, type PersistedRecord } from './fake-tauri-core'
import { openAiChatStream, sseResponse } from './fake-ai'

/** Set by tests before the app boots (page.addInitScript). */
export interface E2EConfig {
  /** list_system_fonts fails (font enumeration error). */
  failFonts?: boolean
  /** Families list_system_fonts returns. */
  fonts?: string[]
  /** The OS user's name preferences_default_author returns ('' = none known). */
  defaultAuthor?: string
  /** ai-connections.json at launch (the AI tutor's connections; the fake provider answers them all). */
  tutorConnections?: Record<string, unknown>[]
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
    /**
     * Export platform fake (src/test-utils/fake-export.ts): set `savePath` (undefined = default,
     * null = Save dialog cancelled), `renderDelayMs`, `failRender`; read `written`, `renders`,
     * `cancels`, `reveals`.
     */
    exports: core.exports,
    /**
     * Spell checker fake (src/test-utils/fake-spellcheck.ts): `misspellings` (word -> suggestions,
     * default teh -> the), `grammar` (phrase -> suggestions), `calls`, `fail`.
     */
    spell: core.spell,
    /**
     * The AI tutor's fake provider (src/test-utils/fake-ai.ts): each queued reply answers one model call
     * as an OpenAI chat-completions stream (text, and/or tool calls). `aiRequests` counts ai_fetch calls
     * (nothing may reach it before the writer sends).
     */
    tutorQueue: (replies: { text?: string; tools?: { name: string; input: unknown }[] }[]) => {
      for (const r of replies) core.ai.queue.push({ events: openAiChatStream(r) })
    },
    aiRequests: () => core.ai.requests.length,
    /** Queue a plain JSON answer (a provider's `GET /models`) for the next model request. */
    tutorQueueJson: (value: unknown) => {
      const events = sseResponse([JSON.stringify(value)])
      events[0] = { type: 'head', status: 200, headers: [['content-type', 'application/json']] }
      core.ai.queue.push({ events })
    },
    /** Every ai_fetch as sent (method, path, body): what reached the provider, in order. */
    aiRequestLog: () => core.ai.requests.map((r) => ({ method: r.req.method, path: r.req.path, body: r.req.body ?? null })),
    /** ai-connections.json as stored (no secret may ever appear in it). */
    tutorConnectionsFile: () => JSON.stringify(core.ai.connections),
    /** The connection ids the keychain holds a secret for, and whether one holds exactly `value`. */
    tutorSecretIds: () => [...core.ai.secrets.keys()],
    tutorSecretIs: (id: string, value: string) => core.ai.secrets.get(id) === value,
    /** Sign in with OpenRouter: the providers Rust was asked to open, and finishing it as Rust does (returns the id). */
    oauthStarts: () => [...core.ai.oauthStarts],
    completeOAuth: (key: string) => core.completeOAuth(key),
    /** The tutor's chat history as stored (project id to chat titles). */
    tutorHistory: () => Object.fromEntries([...core.ai.history].map(([project, chats]) => [project, [...chats.values()].map((c) => c.title)])),
    /** The export wizard's fixture: manuscript.json, comments.json, rewrites.json and the book's styles. */
    exportWizardFixture: () => ({ doc: WIZARD_FIXTURE_DOC, comments: WIZARD_FIXTURE_COMMENTS, rewrites: WIZARD_FIXTURE_REWRITES, styles: WIZARD_FIXTURE_STYLES }),
    /** The export wizard's state (open, step, the run's phase). */
    exportWizardState: () => {
      const w = getWizardState()
      return { open: w.open, step: w.step, phase: w.run.phase, problem: w.run.error?.problem ?? null }
    },
    /** The bytes of a file the export wrote (the real DOCX; the PDF is the fake core's stub), or null. */
    exportedBytes: (path: string) => {
      const bytes = core.exports.written.get(path)
      return bytes ? Array.from(bytes) : null
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
    /** preferences.json as stored (null = no file); and replace it, even with damaged text. */
    preferencesFile: () => state.preferences,
    setPreferencesFile: (text: string | null) => core.seedPreferences(text),
    /** Ask for the author name as a tracked change or comment would (shows the one-time question). */
    ensureAuthorName: () => ensureAuthorName(),
    /** The preferences slice as the app holds it. */
    preferences: () => useStore.getState().preferences,
    /** Labels of File > Open Recent in the last native menu snapshot (menu_set). */
    recentMenu: () => {
      type Node = { kind: string; label?: string; items?: Node[] }
      const file = state.menu?.menus.find((m) => m.id === 'file')
      const recent = (file?.items as Node[] | undefined)?.find((n) => n.kind === 'submenu' && n.label === 'Open Recent')
      return (recent?.items ?? []).map((n) => n.label ?? '')
    },
    /** The last native menu snapshot (menu_set), as Rust would build it. */
    nativeMenu: () => state.menu,
    /** Registered commands with a shortcut, and the keys as shown on this platform. */
    shortcutRows: () =>
      getCommands()
        .filter((c) => c.shortcut)
        .map((c) => ({ id: c.id, label: c.label, keys: formatShortcut(c.shortcut!) })),
    fullscreen: () => state.fullscreen,
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
    /** Navigation pane: how long its last tree rebuild took (ms; perf report). */
    outlineBuildMs: () => +outlineDebug.lastBuildMs.toFixed(2),
    // ---- Pagination (Phase 2) ----
    /** The engine has laid out the current document and no reflow is pending. */
    paginationSettled: () => getPaginationDebug().settled,
    /** Page model current and the pages in view drawn (off-screen offsets may still be applying). */
    paginationModelSettled: () => getPaginationDebug().modelSettled,
    /** Px reserved at the bottom of each page. */
    paginationReserved: () => getPaginationDebug().reserved,
    /** Engine internals for diagnostics: line count and the line range of each page. */
    /** Diagnostics: the editor state's document, and the editor DOM's top-level structure. */
    editorDiag: () => {
      const ed = getEditor()
      if (!ed) return null
      const dom = Array.from(ed.view.dom.children).map((el) => `${el.tagName}.${el.className}[${(el.textContent ?? '').slice(0, 20)}]`)
      return { state: ed.state.doc.toString(), selection: ed.state.selection.toJSON(), dom, active: document.activeElement?.className ?? null }
    },
    paginationLines: () => {
      const d = getPaginationDebug()
      return { lineCount: d.lineCount, lineRanges: d.lineRanges, lastPass: d.lastPass, passes: d.passes }
    },
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
    /** Page navigation (app preference): Book (page turns, the default) or continuous scroll. */
    setPageNavigation: (mode: 'book' | 'scroll') => useStore.getState().preferencesActions.set('pageNavigation', mode),
    pageNavigation: () => useStore.getState().preferences.pageNavigation,
    /** View > Next / Previous Spread (dir 1 / -1) and First / Last Spread. */
    turnSpread: (dir: 1 | -1) => turnSpread(dir),
    edgeSpread: (dir: 1 | -1) => goToEdgeSpread(dir),
    /** Show the spread holding page `index` (view only; Book mode turns to it). */
    showPage: (index: number) => showPage(index),
    /** Bring an editor element's start into view (Book mode turns to its spread). */
    revealElement: (el: Element) => {
      const ed = getEditor()
      if (!ed) return false
      try {
        return revealPosition(ed.view.posAtDOM(el, 0))
      } catch {
        return false
      }
    },
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
      relayoutPagination()
    },
    /** Reserve `px` at the bottom of every page whose range contains `pos` (footnote stand-in); null removes. */
    reserveBottom: (pos: number | null, px = 0) => {
      e2eReservation?.()
      e2eReservation = pos === null ? null : registerBottomReservation('e2e', (p) => (p.from <= pos && pos < p.to ? px : 0))
    },
    /** Footnotes: px of the footnote area of each page, and the note lines placed on each page. */
    footnoteAreas: () => ({ heights: footnoteAreaHeights(), placement: footnotePlacement() }),
    /** The manuscript's footnotes in order: reference position, derived label, note text. */
    footnotes: () => getFootnotes().map((r) => ({ pos: r.pos, label: r.label, text: r.node.textContent })),
    /** Replace the document (as a project load does). */
    setDoc: (doc: unknown) => setDocJSON(doc as Parameters<typeof setDocJSON>[0]),
    /** Insert a paragraph holding `text` at top-level position `pos`. */
    insertParagraphAt: (pos: number, text: string) => {
      const ed = getEditor()
      if (!ed) return
      ed.view.dispatch(ed.state.tr.insert(pos, ed.schema.nodes.paragraph.create(null, ed.schema.text(text))))
    },
    /** Re-measure every block (pagination), e.g. to check that incremental measurement was right. */
    remeasureAll: () => invalidatePagination(),
    /** Insert a footnote with `text` at document position `pos` (no editor opened). */
    insertFootnoteAt: (pos: number, text: string) => {
      const ed = getEditor()
      if (!ed) return
      const schema = ed.schema
      ed.view.dispatch(ed.state.tr.insert(pos, schema.nodes.footnote.create(null, text ? schema.text(text) : null)))
    },
    // ---- Track changes (Phase 3) ----
    /** Turn recording on or off (the book setting the toolbar toggle writes). */
    setTracking: (on: boolean) => setTracking(on),
    /** View ▸ Markup. */
    setMarkupView: (view: MarkupView) => setMarkupView(view),
    /** Number of tracked changes in the document. */
    countChanges: () => {
      const ed = getEditor()
      return ed ? countChanges(ed.state) : 0
    },
    /** Accept (or reject) every change, as one transaction. */
    resolveAllChanges: (mode: 'accept' | 'reject') => {
      const ed = getEditor()
      if (!ed) return
      const tr = mode === 'accept' ? acceptAll(ed.state) : rejectAll(ed.state)
      if (tr) ed.view.dispatch(tr)
    },
    /**
     * The first characters of text shown at the top of each page in the current markup view
     * ('(blank)' for a blank page): compares page breaks between documents whose positions differ.
     */
    pageStarts: (chars = 24) => {
      const ed = getEditor()
      if (!ed) return []
      const view = useStore.getState().trackChanges.markupView
      const doc = ed.state.doc
      return useStore.getState().layout.pages.map((pg) => {
        if (pg.isBlank) return '(blank)'
        let out = ''
        doc.nodesBetween(pg.from, pg.to, (n, pos) => {
          if (out.length >= chars || n.type.name === 'footnote') return false
          if (n.isBlock && isBlockHidden(n, view)) return false
          if (n.isText && !isInlineHidden(n, view)) out += n.text!.slice(Math.max(0, pg.from - pos))
          return true
        })
        return out.slice(0, chars)
      })
    },
    /** The document as saved (manuscript.json shape). */
    docJSON: () => getDocJSON(),
    /** Editor document version (bumps on every document change; style edits must not bump it). */
    docVersion: () => useStore.getState().editor.docVersion,
    /**
     * Make the editor read the DOM selection now. ProseMirror picks up a click / End-key caret move
     * on the async `selectionchange` event; a test that presses the next key (or changes a toolbar
     * select) within the same task can otherwise act on the previous selection under CPU load.
     */
    syncSelection: () => {
      const view = getEditor()?.view as unknown as { domObserver?: { flush(): void } } | undefined
      view?.domObserver?.flush()
    },
    // ---- Export (Phase 4) ----
    /**
     * Build the manuscript IR of the open document `runs` times (after one warm-up), from the editor's
     * document and from its JSON (the worker path: JSON parsed into the schema first). Times in ms.
     */
    buildManuscriptTimes: (runs = 5) => {
      const ed = getEditor()
      if (!ed) return null
      const doc = ed.state.doc
      const json = doc.toJSON()
      const styles = getResolvedStyles()
      const footnotes = useStore.getState().book.footnotes
      const time = (fn: () => unknown) => {
        const t0 = performance.now()
        fn()
        return +(performance.now() - t0).toFixed(1)
      }
      const ir = buildManuscript(doc, styles, { footnotes })
      const ms = Array.from({ length: runs }, () => time(() => buildManuscript(doc, styles, { footnotes })))
      const fromJsonMs = Array.from({ length: runs }, () => time(() => buildManuscript(json, styles, { footnotes })))
      const blocks = ir.frontMatter.length + ir.chapters.reduce((n, c) => n + c.blocks.length, 0)
      return { ms, fromJsonMs, chapters: ir.chapters.length, blocks, footnotes: ir.footnotes.length, trackedChanges: ir.report.trackedChanges.total }
    },
    /**
     * Export the open document as DOCX with the real renderer (in its Web Worker) `runs` times after
     * one warm-up: the IR build plus the render, as the wizard runs them. Times in ms; the progress
     * fractions of the last run; whether the page kept painting frames during it. `preset` 'classic'
     * adds the two-spaces-after-a-sentence pass and underline for italics.
     */
    renderDocxTimes: async (runs = 3, preset: 'standard' | 'classic' = 'standard') => {
      const ed = getEditor()
      if (!ed) return null
      const styles = getResolvedStyles()
      const footnotes = useStore.getState().book.footnotes
      const renderer = createDocxRenderer()
      const settings = { ...applyPreset(defaultManuscriptSettings('en-US'), preset), info: { title: 'Perf', contact: { legalName: 'A Writer', penName: '', address: '', phone: '', email: '', agent: '' }, wordCount: 0 } }
      const once = async (onProgress?: (p: { fraction: number }) => void) => {
        const t0 = performance.now()
        const ir = buildManuscript(ed.state.doc, styles, { footnotes })
        // The wizard counts once, then renders (the count is part of the export time).
        const bytes = await renderer.render(ir, { ...settings, info: { ...settings.info, wordCount: manuscriptWordCount(ir).total } }, { onProgress })
        return { ms: +(performance.now() - t0).toFixed(1), bytes: bytes.length }
      }
      await once()
      const ms: number[] = []
      let bytes = 0
      const fractions: number[] = []
      let frames = 0
      let counting = true
      const tick = () => {
        frames++
        if (counting) requestAnimationFrame(tick)
      }
      for (let i = 0; i < runs; i++) {
        if (i === runs - 1) requestAnimationFrame(tick)
        const r = await once(i === runs - 1 ? (p) => fractions.push(p.fraction) : undefined)
        ms.push(r.ms)
        bytes = r.bytes
      }
      counting = false
      return { ms, bytes, fractions, frames }
    },
    /** Start a DOCX export of the open document, cancel it after `afterMs`; what the render settled with. */
    cancelDocxRender: async (afterMs = 20) => {
      const ed = getEditor()
      if (!ed) return null
      const ir = buildManuscript(ed.state.doc, getResolvedStyles(), { footnotes: useStore.getState().book.footnotes })
      const settings = { ...defaultManuscriptSettings('en-US'), info: { title: 'Perf', contact: { legalName: 'A Writer', penName: '', address: '', phone: '', email: '', agent: '' }, wordCount: 0 } }
      const ac = new AbortController()
      let progressAfterCancel = 0
      setTimeout(() => ac.abort(), afterMs)
      const t0 = performance.now()
      const outcome = await createDocxRenderer()
        .render(ir, settings, { signal: ac.signal, onProgress: () => ac.signal.aborted && progressAfterCancel++ })
        .then((b) => ({ resolved: true, bytes: b.length, error: null as string | null }))
        .catch((e: unknown) => ({ resolved: false, bytes: 0, error: isAbortError(e) ? 'AbortError' : String(e) }))
      return { ...outcome, settledMs: +(performance.now() - t0).toFixed(1), progressAfterCancel }
    },
    // ---- Comments (Phase 3) ----
    /** Start recording when each layoutVersion is published (performance.now()); returns the record. */
    watchLayoutPublishes: () => {
      const times: Record<number, number> = {}
      useStore.subscribe((st, prev) => {
        if (st.layout.layoutVersion !== prev.layout.layoutVersion) times[st.layout.layoutVersion] = performance.now()
      })
      ;(window as unknown as { __nvLayoutTimes: Record<number, number> }).__nvLayoutTimes = times
    },
    layoutPublishedAt: (version: number) => (window as unknown as { __nvLayoutTimes?: Record<number, number> }).__nvLayoutTimes?.[version] ?? null,
    /** Select document positions `from..to` in the manuscript (as a mouse drag would). */
    selectText: (from: number, to: number) => {
      const view = getEditor()?.view
      if (!view) return
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)))
    },
    /** Where the caret at `pos` is painted (ProseMirror coordsAtPos; side -1: the end of the line before). */
    coordsAt: (pos: number, side: 1 | -1 = 1) => {
      const view = getEditor()?.view
      if (!view) return null
      const c = view.coordsAtPos(pos, side)
      return { left: c.left, top: c.top, bottom: c.bottom }
    },
    /** Selection of the manuscript. */
    selection: () => {
      const s = getEditor()?.state.selection
      return s ? { from: s.from, to: s.to } : null
    },
    /** The comments mirror (threads, active thread) and the last margin-panel layout. */
    comments: () => {
      const c = useStore.getState().comments
      return { threads: c.threads, activeId: c.activeId, showResolved: c.showResolved, layout: { ...commentsDebug } }
    },
    /** Re-writes in the store, the open one, and the comparison view's last open / layout timing. */
    rewrite: () => {
      const r = useStore.getState().rewrite
      return {
        rewrites: r.rewrites,
        openId: r.openId,
        activeVersionId: r.activeVersionId,
        version: r.version,
        caretIn: r.caretIn,
        notice: r.notice,
        debug: { mountedAt: rewriteDebug.mountedAt, readyAt: rewriteDebug.readyAt, layouts: rewriteDebug.layouts, rows: rewriteDebug.rows.map((x) => x.kind) },
      }
    },
    /** Run a registered command as its menu item would (false when absent or disabled). */
    runCommand: (id: string) => runCommand(id),
    /** Start position of top-level block `index` of the manuscript. */
    blockPos: (index: number) => {
      const doc = getEditor()?.state.doc
      let pos = 0
      for (let k = 0; doc && k < index; k++) pos += doc.child(k).nodeSize
      return pos
    },
    /** book.styles as stored (overrides only). */
    bookStyles: () => useStore.getState().book.styles,
    /**
     * Append the top-level block `index` itself (the same node instance, not a copy) at the end of
     * the document: ProseMirror shares unchanged nodes, so one instance can sit at two places.
     */
    appendSameBlock: (index: number) => {
      const view = getEditor()?.view
      if (!view) return
      const doc = view.state.doc
      view.dispatch(view.state.tr.insert(doc.content.size, doc.child(index)))
    },
    /** Delete the whole top-level block `index` (its neighbours stay the same node instances). */
    deleteBlock: (index: number) => {
      const view = getEditor()?.view
      if (!view) return
      const doc = view.state.doc
      let pos = 0
      for (let k = 0; k < index; k++) pos += doc.child(k).nodeSize
      view.dispatch(view.state.tr.delete(pos, pos + doc.child(index).nodeSize))
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
  if (config.defaultAuthor !== undefined) core.state.defaultAuthor = config.defaultAuthor
  if (config.tutorConnections) core.ai.connections = structuredClone(config.tutorConnections)
  // A preferences.json seed for this launch, when there is no file yet (e2e/helpers.ts
  // seedPreferences: specs that need continuous scroll navigation).
  const seed = (window as unknown as { __nvE2EPreferences?: string }).__nvE2EPreferences
  if (seed !== undefined && core.state.preferences === null) core.state.preferences = seed
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
  // mockIPC drops invoke options; the export write names its target in headers (as Rust reads them).
  const internals = window.__TAURI_INTERNALS__ as unknown as { invoke: (cmd: string, args?: unknown, options?: { headers?: unknown }) => Promise<unknown> }
  const mockedInvoke = internals.invoke
  internals.invoke = (cmd, args, options) => (cmd === 'export_write_file' ? core.handle(cmd, args as Record<string, unknown>, options) : mockedInvoke(cmd, args, options))
  ;(globalThis as unknown as { isTauri: boolean }).isTauri = true
  window.__nvE2E = controlFor(core)
}
