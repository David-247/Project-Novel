import { Extension } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state'
import { Mapping } from '@tiptap/pm/transform'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import { getEditor } from '@/features/editor'
import { useStore, type RootState } from '@/shared/store'
import { blockCheckText, isContiguous, textRangeToDoc, type CheckText } from './block-text'
import { dictionaryWords } from './dictionary'
import { hashText } from './hash'
import { checkBlocks } from './check'
import type { Finding } from './types'
import './spellcheck.css'

/**
 * The editor's spell and grammar underlines (Phase 5): a ProseMirror plugin whose decorations are
 * Harper's findings (`spell-error`: red wavy, `grammar-error`: blue double).
 *
 * When: 400 ms after the last edit, scroll, page turn or reflow (never in the keystroke's own
 * transaction). What: the blocks on the pages in view and the page either side (the store's `layout`),
 * plus blocks changed elsewhere (a Replace All), at most SPELL_CHECK_CHUNK per engine call. Unchanged
 * text is answered from the slice's cache, so a scroll back costs no engine call. The result lands as
 * one decoration-only transaction (no history, no document change); underlines elsewhere are carried
 * through edits by mapping and refreshed when their page comes into view.
 *
 * The text checked is No Markup's (block-text.ts): tracked deletions out, footnote references out.
 * A spelling finding that ends at the caret while the writer is typing there waits until the caret
 * leaves (Word does not flag the word being typed).
 */
export const SPELL_CHECK_DEBOUNCE_MS = 400
export const SPELL_CHECK_CHUNK = 200
/** Without a page layout (none published yet): this many characters either side of the caret. */
const FALLBACK_CHARS = 20_000

export const spellcheckKey = new PluginKey<SpellState>('spellcheck')

/** What an underline carries (decoration spec `spell`). */
export interface SpellSpec {
  finding: Finding
  /** The key the block was checked under (the hash of its text): Ignore Once uses it. */
  blockKey: string
  /** The flagged text as checked. */
  text: string
  /** The document holds exactly `text` at the underline (no hidden content inside): it can be replaced. */
  contiguous: boolean
}

/** A finding where it is in the document now. */
export type LocatedFinding = Finding & { from: number; to: number; blockKey: string }

interface SpellState {
  set: DecorationSet
  /** New with every state the plugin starts in (a loaded document): results from before are dropped. */
  epoch: number
  /** The caret after the last typing (an edit that left an empty selection), carried through edits. */
  typingAt: number | null
}

type SpellMeta =
  | { replace: { from: number; to: number; decorations: Decoration[] }[] }
  | { remove: (spec: SpellSpec) => boolean }
  | { clear: true }

let epochs = 0

const specOf = (d: Decoration): SpellSpec | undefined => (d.spec as { spell?: SpellSpec }).spell
const isSpell = (spec: { spell?: SpellSpec }) => !!spec.spell

/** How a dictionary word compares (as in Rust): lowercase, a possessive 's or ’s left off. */
export function wordKey(word: string): string {
  const w = word.trim().toLowerCase()
  const m = /^(.+?)['’]s$/.exec(w)
  return m ? m[1] : w
}

/**
 * The same underline, whichever check made its spec: the menu holds the spec of the underline it
 * opened on, and a recheck since may have replaced the object (same block text, same finding).
 */
export function sameUnderline(a: SpellSpec, b: SpellSpec): boolean {
  return a === b || (a.blockKey === b.blockKey && a.finding.start === b.finding.start && a.finding.end === b.finding.end && a.finding.kind === b.finding.kind && a.finding.rule === b.finding.rule)
}

/** Whether a block's underlines would be redrawn the same: then the old decorations are kept as they are. */
function sameDecorations(old: readonly Decoration[], fresh: readonly Decoration[]): boolean {
  if (old.length !== fresh.length) return false
  const a = [...old].sort((x, y) => x.from - y.from || x.to - y.to)
  const b = [...fresh].sort((x, y) => x.from - y.from || x.to - y.to)
  return a.every((d, i) => {
    const e = b[i]
    const x = specOf(d)!
    const y = specOf(e)!
    return (
      d.from === e.from &&
      d.to === e.to &&
      sameUnderline(x, y) &&
      x.text === y.text &&
      x.contiguous === y.contiguous &&
      x.finding.message === y.finding.message &&
      x.finding.suggestions.join('\n') === y.finding.suggestions.join('\n')
    )
  })
}

/** The underlines of one block (at `pos`, with its check text) for its findings. */
function blockDecorations(check: CheckText, findings: readonly Finding[], blockKey: string, suppressAt: number | null): Decoration[] {
  const out: Decoration[] = []
  for (const f of findings) {
    const r = textRangeToDoc(check.segments, f.start, f.end)
    if (!r) continue
    if (f.kind === 'spelling' && suppressAt !== null && r.to === suppressAt) continue
    const spec: SpellSpec = { finding: f, blockKey, text: check.text.slice(f.start, f.end), contiguous: isContiguous(check.segments, f.start, f.end) }
    out.push(Decoration.inline(r.from, r.to, { class: f.kind === 'spelling' ? 'spell-error' : 'grammar-error' }, { spell: spec }))
  }
  return out
}

interface Target {
  pos: number
  key: string
  text: string
  /** From the record of changed blocks (not only in view): kept in it when the check fails. */
  changed?: boolean
}

/** The textblocks touching [from, to). */
function textblocksIn(doc: PMNode, from: number, to: number, visit: (node: PMNode, pos: number) => void) {
  const a = Math.max(0, Math.min(from, doc.content.size))
  const b = Math.max(a, Math.min(to, doc.content.size))
  doc.nodesBetween(a, b, (node, pos) => {
    if (node.isTextblock) {
      visit(node, pos)
      return false
    }
    return true
  })
}

/** The document range in view: the pages of the visible spread and one page either side. */
function visibleRange(state: EditorState, s: RootState): { from: number; to: number } {
  const { pages, visibleSpread } = s.layout
  if (pages.length > 0) {
    const first = pages[Math.max(0, Math.min(visibleSpread.first - 1, pages.length - 1))]
    const last = pages[Math.max(0, Math.min(visibleSpread.last + 1, pages.length - 1))]
    return { from: first.from, to: Math.max(first.from, last.to) }
  }
  const head = state.selection.head
  return { from: head - FALLBACK_CHARS, to: head + FALLBACK_CHARS }
}

interface Controller {
  view: EditorView | null
  timer: ReturnType<typeof setTimeout> | null
  running: boolean
  again: boolean
  /** Ranges changed since the last check (current positions; mapped by every transaction). */
  dirty: [number, number][]
  /** Mappings of the checks in flight, each appended to by every transaction since it started. */
  inflight: Set<Mapping>
  /** A finding was held back because it ends at the caret being typed: a caret move shows it. */
  heldBack: boolean
  /** The engine failed once (logged once). */
  failed: boolean
}

/** More changed ranges than this collapse into one (a Replace All): bounded work per transaction. */
const MAX_DIRTY_RANGES = 32

/** Record what `tr` changed, in its new positions (each step's ranges carried through the steps after it). */
function addDirty(c: Controller, tr: Transaction) {
  let ranges = c.dirty
  for (const map of tr.mapping.maps) {
    const next: [number, number][] = ranges.map(([a, b]) => [map.map(a, -1), map.map(b, 1)])
    map.forEach((_oldStart, _oldEnd, newStart, newEnd) => next.push([newStart, newEnd]))
    ranges = next.length > MAX_DIRTY_RANGES ? [[Math.min(...next.map((r) => r[0])), Math.max(...next.map((r) => r[1]))]] : next
  }
  c.dirty = ranges
}

/** Mark `targets` (positions as of the check's start, carried by `mapping`) as changed again. */
function keepDirty(c: Controller, targets: readonly Target[], mapping: Mapping) {
  const doc = c.view && !c.view.isDestroyed ? c.view.state.doc : null
  if (!doc) return
  const ranges = c.dirty.slice()
  for (const t of targets) {
    const at = mapping.mapResult(t.pos, 1)
    if (at.deleted) continue
    const node = doc.nodeAt(at.pos)
    if (node?.isTextblock) ranges.push([at.pos, at.pos + node.nodeSize])
  }
  c.dirty = ranges.length > MAX_DIRTY_RANGES ? [[Math.min(...ranges.map((r) => r[0])), Math.max(...ranges.map((r) => r[1]))]] : ranges
}

const enabled = () => useStore.getState().preferences.spellcheck.enabled !== false

/** Collect what to check now: the blocks in view, then changed blocks elsewhere (up to one chunk). */
function targetsFor(state: EditorState, c: Controller): { targets: Target[]; dropped: { from: number; to: number }[] } {
  const seen = new Set<number>()
  const targets: Target[] = []
  const dropped: { from: number; to: number }[] = []
  const add = (node: PMNode, pos: number, changed = false) => {
    if (seen.has(pos)) return
    seen.add(pos)
    const { text } = blockCheckText(node, pos)
    targets.push({ pos, key: hashText(text), text, ...(changed ? { changed } : {}) })
  }
  const view = visibleRange(state, useStore.getState())
  textblocksIn(state.doc, view.from, view.to, (node, pos) => add(node, pos))
  let budget = SPELL_CHECK_CHUNK
  for (const [a, b] of c.dirty) {
    textblocksIn(state.doc, a, b, (node, pos) => {
      if (seen.has(pos)) return
      if (budget > 0) {
        budget--
        add(node, pos, true)
      } else {
        // Beyond the budget: no stale underline is left; the block is checked when it comes into view.
        seen.add(pos)
        dropped.push({ from: pos, to: pos + node.nodeSize })
      }
    })
  }
  c.dirty = []
  return { targets, dropped }
}

async function runCheck(c: Controller): Promise<void> {
  const view = c.view
  if (!view || view.isDestroyed || !enabled()) return
  if (c.running) {
    c.again = true
    return
  }
  c.running = true
  const start = view.state
  const epoch = spellcheckKey.getState(start)?.epoch
  const { targets, dropped } = targetsFor(start, c)
  // Changed blocks beyond the budget lose their underlines now (no stale underline is left).
  if (dropped.length) view.dispatch(start.tr.setMeta(spellcheckKey, { replace: dropped.map((d) => ({ ...d, decorations: [] })) } satisfies SpellMeta).setMeta('addToHistory', false))
  const mapping = new Mapping()
  c.inflight.add(mapping)
  try {
    for (let i = 0; i < targets.length; i += SPELL_CHECK_CHUNK) {
      const chunk = targets.slice(i, i + SPELL_CHECK_CHUNK)
      let found: Map<string, Finding[]>
      try {
        found = await checkBlocks(chunk.map((t) => ({ id: t.key, text: t.text })))
      } catch (e) {
        if (!c.failed) console.error('[spellcheck] the check failed; underlines stay as they were', e)
        c.failed = true
        // What was not checked stays marked as changed, so the next check takes it again (final C-M9).
        keepDirty(c, targets.slice(i).filter((t) => t.changed), mapping)
        return
      }
      const v = c.view
      if (!v || v.isDestroyed || !enabled()) return
      const state = v.state
      const st = spellcheckKey.getState(state)
      if (!st || st.epoch !== epoch) return
      const typing = st.typingAt !== null && state.selection.empty && state.selection.head === st.typingAt ? st.typingAt : null
      const replace: { from: number; to: number; decorations: Decoration[] }[] = []
      for (const t of chunk) {
        const at = mapping.mapResult(t.pos, 1)
        if (at.deleted) continue
        const node = state.doc.nodeAt(at.pos)
        if (!node?.isTextblock) continue
        const check = blockCheckText(node, at.pos)
        // Edited again while it was checked: its change is recorded, it is checked next time.
        if (check.text !== t.text) continue
        const decorations = blockDecorations(check, found.get(t.key) ?? [], t.key, typing)
        if (typing !== null && decorations.length < (found.get(t.key) ?? []).length) c.heldBack = true
        // Unchanged: keep the decorations (and their specs) as they are, so the block is not redrawn
        // (an IME composition in it is left alone) and an open menu's underline is still the same one.
        const to = at.pos + node.nodeSize
        if (sameDecorations(st.set.find(at.pos + 1, Math.max(at.pos + 1, to - 1), isSpell), decorations)) continue
        replace.push({ from: at.pos, to, decorations })
      }
      if (replace.length) v.dispatch(state.tr.setMeta(spellcheckKey, { replace } satisfies SpellMeta).setMeta('addToHistory', false))
    }
  } finally {
    c.inflight.delete(mapping)
    c.running = false
    if (c.again) {
      c.again = false
      schedule(c)
    }
  }
}

function schedule(c: Controller, ms = SPELL_CHECK_DEBOUNCE_MS) {
  if (c.timer) clearTimeout(c.timer)
  c.timer = setTimeout(() => {
    c.timer = null
    void runCheck(c)
  }, ms)
}

function dispatchMeta(c: Controller, meta: SpellMeta) {
  const v = c.view
  if (!v || v.isDestroyed || !spellcheckKey.getState(v.state)) return
  v.dispatch(v.state.tr.setMeta(spellcheckKey, meta).setMeta('addToHistory', false))
}

/** Drop the spelling underlines of words the dictionary now holds (everywhere, at once). */
function pruneDictionary(c: Controller) {
  const words = new Set(dictionaryWords().map(wordKey))
  dispatchMeta(c, { remove: (s) => s.finding.kind === 'spelling' && words.has(wordKey(s.text)) })
}

function createPlugin(c: Controller) {
  return new Plugin<SpellState>({
    key: spellcheckKey,
    state: {
      init: () => ({ set: DecorationSet.empty, epoch: ++epochs, typingAt: null }),
      apply(tr, value, _old, next): SpellState {
        let { set, typingAt } = value
        if (tr.docChanged) {
          set = set.map(tr.mapping, tr.doc)
          for (const m of c.inflight) m.appendMapping(tr.mapping)
          addDirty(c, tr)
          typingAt = next.selection.empty ? next.selection.head : null
        } else if (tr.selectionSet) typingAt = null
        const meta = tr.getMeta(spellcheckKey) as SpellMeta | undefined
        if (meta && 'clear' in meta) set = DecorationSet.empty
        else if (meta && 'remove' in meta) set = set.remove(set.find(undefined, undefined, (s: { spell?: SpellSpec }) => !!s.spell && meta.remove(s.spell)))
        else if (meta && 'replace' in meta) {
          const added: Decoration[] = []
          for (const r of meta.replace) {
            set = set.remove(set.find(r.from + 1, Math.max(r.from + 1, r.to - 1), isSpell))
            added.push(...r.decorations)
          }
          if (added.length) set = set.add(tr.doc, added)
        }
        return set === value.set && typingAt === value.typingAt ? value : { set, epoch: value.epoch, typingAt }
      },
    },
    props: {
      decorations: (state) => spellcheckKey.getState(state)?.set,
    },
    view(view) {
      c.view = view
      const offStore = useStore.subscribe((s, prev) => {
        if (s.preferences.spellcheck.enabled !== prev.preferences.spellcheck.enabled) {
          if (s.preferences.spellcheck.enabled === false) {
            if (c.timer) clearTimeout(c.timer)
            c.timer = null
            dispatchMeta(c, { clear: true })
          } else schedule(c)
        }
        if (s.preferences.spellcheck.words !== prev.preferences.spellcheck.words || s.spellcheck.projectWords !== prev.spellcheck.projectWords) {
          pruneDictionary(c)
          if (enabled()) schedule(c)
        }
        const l = s.layout
        const p = prev.layout
        if (l.layoutVersion !== p.layoutVersion || l.visibleSpread !== p.visibleSpread) {
          if (enabled()) schedule(c)
        }
      })
      if (enabled()) schedule(c)
      return {
        update(v, prevState) {
          const st = spellcheckKey.getState(v.state)
          const before = spellcheckKey.getState(prevState)
          if (st && before && st.epoch !== before.epoch) {
            // A document was loaded (a new state, not a transaction): only what is in view now.
            c.dirty = []
            if (enabled()) schedule(c)
          } else if (v.state.doc !== prevState.doc) {
            if (enabled()) schedule(c)
          } else if (c.heldBack && !v.state.selection.eq(prevState.selection)) {
            c.heldBack = false
            if (enabled()) schedule(c)
          }
        },
        destroy() {
          offStore()
          if (c.timer) clearTimeout(c.timer)
          c.timer = null
          if (c.view === view) c.view = null
        },
      }
    },
  })
}

/**
 * The spell check underlines for the manuscript editor (pass it to <NovelEditor extensions>). On
 * while `preferences.spellcheck.enabled` (View ▸ Spelling & Grammar).
 */
export function createSpellcheckExtension(): Extension {
  return Extension.create({
    name: 'spellcheck',
    addProseMirrorPlugins() {
      const c: Controller = { view: null, timer: null, running: false, again: false, dirty: [], inflight: new Set(), heldBack: false, failed: false }
      return [createPlugin(c)]
    },
  })
}

/** The underlines of `state` touching [from, to] (a caret position: those around it). */
export function findingsIn(state: EditorState, from: number, to: number): { spec: SpellSpec; from: number; to: number }[] {
  const st = spellcheckKey.getState(state)
  if (!st) return []
  return st.set
    .find(from, to, isSpell)
    .map((d) => ({ spec: specOf(d)!, from: d.from, to: d.to }))
    .sort((a, b) => a.from - b.from)
}

/** The findings underlined in the manuscript touching [from, to], where they are now. */
export function getFindingsInRange(from: number, to: number): LocatedFinding[] {
  const ed = getEditor()
  if (!ed || ed.isDestroyed) return []
  return findingsIn(ed.state, from, to).map(({ spec, from: f, to: t }) => ({ ...spec.finding, from: f, to: t, blockKey: spec.blockKey }))
}

/** Remove one underline (Ignore Once, an applied suggestion) in the transaction `tr`, or on its own. */
export function removeUnderline(tr: Transaction, spec: SpellSpec): Transaction {
  return tr.setMeta(spellcheckKey, { remove: (s) => sameUnderline(s, spec) } satisfies SpellMeta)
}

/** Test-only: the specs of every underline of `state`, in document order. */
export function getUnderlineSpecsForTests(state: EditorState): SpellSpec[] {
  return findingsIn(state, 0, state.doc.content.size).map((f) => f.spec)
}
