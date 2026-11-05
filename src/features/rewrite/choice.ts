import type { Node as PMNode } from '@tiptap/pm/model'
import { TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state'
import { closeHistory } from '@tiptap/pm/history'
import type { Editor } from '@tiptap/core'
import { blockPlainText, chapterIndexAt, getChapters, getEditor } from '@/features/editor'
import { currentTrackAuthor, isTracking, trackTransaction, TRACK_FAILED_META, TRACK_FAILED_NOTICE, TRACK_SKIP_META, TRACKED_META } from '@/features/track-changes'
import type { DocNodeJSON } from '@/shared/document'
import { REWRITE_BLOCK_ATTR } from '@/shared/rewrite'
import { useStore, type RewriteLocation, type RewriteRecord } from '@/shared/store'
import { similarity } from './align'
import { ANCHOR_TYPES, openAnchorsIn, passageProblem, passageRange, REWRITE_ALLOW_META } from './anchor'
import { chapterChanges, replacePassage } from './apply'
import { closeRewrite, compact, currentPassageDoc, flushLiveVersions, getRewrite, nextSeq, openRewrite, versionDoc } from './commands'
import { CHOICE_ORIGINAL, passageDoc } from './model'
import { RewriteStateStep, type RewriteStepState } from './step'

/**
 * The re-write choice (docs/design.md, "Re-write"; docs/project-format.md, "rewrites.json"):
 * - Keep This Version: the manuscript passage becomes the version (a word-level edit, apply.ts;
 *   tracked when Track Changes records), the re-write resolved with choice = the version's id;
 * - Keep Original: the passage stays as it is, the re-write resolved with choice 'original';
 * - Discard Re-write: the re-write and its versions are removed; the passage stays as it is;
 * - Reopen (a resolved re-write, from the Re-writes list): the passage is found again in the
 *   manuscript and is the new original; the re-write is open again with its versions.
 * Each is ONE manuscript transaction holding the text edit, the passage's anchors (removed when it
 * resolves, set when it reopens) and a RewriteStateStep (step.ts), its own undo event: one Mod-z
 * undoes all of it (the re-write open again with every version), redo does it again. The store and
 * rewrites.json follow the step (anchor.ts).
 */

const store = () => useStore.getState()
const actions = () => useStore.getState().rewriteActions

export interface RewriteConfirmRequest {
  title: string
  message: string
  confirmLabel: string
}
export type RewriteConfirm = (req: RewriteConfirmRequest) => Promise<boolean>

const windowConfirm: RewriteConfirm = async ({ message }) => {
  try {
    return window.confirm(message)
  } catch {
    return false
  }
}
let confirmFn: RewriteConfirm = windowConfirm
/** How Keep This Version asks before it adds or removes a chapter title (the composition root: the app's message dialog). */
export function setRewriteConfirm(fn: RewriteConfirm | null): void {
  confirmFn = fn ?? windowConfirm
}

const OPEN: RewriteStepState = { status: 'open', choice: null }

/** The resolution fields of `r` now (a step's `before`). */
function stateOf(r: RewriteRecord, withOriginal = false): RewriteStepState {
  return {
    status: r.status,
    choice: r.choice ?? null,
    ...(r.resolvedAt ? { resolvedAt: r.resolvedAt } : {}),
    ...(r.kept ? { kept: r.kept } : {}),
    ...(r.location ? { location: r.location } : {}),
    ...(withOriginal ? { original: r.original } : {}),
  }
}

/** Steps clearing the anchor `anchor` from every block that carries it. */
function clearAnchor(tr: Transaction, anchor: string): void {
  tr.doc.forEach((node, offset) => {
    if (node.attrs[REWRITE_BLOCK_ATTR] === anchor) tr.setNodeAttribute(offset, REWRITE_BLOCK_ATTR, null)
  })
}

/** Dispatch `tr` as its own undo event (the edit after it starts another one); selection at `caret`. */
function dispatchAlone(ed: Editor, tr: Transaction, caret: number | null): void {
  if (caret !== null) tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(caret, tr.doc.content.size))))
  tr.setMeta(REWRITE_ALLOW_META, true)
  ed.view.dispatch(closeHistory(tr))
  ed.view.dispatch(closeHistory(ed.state.tr))
}

/** Back to the manuscript after a choice: the caret where it was put, scrolled to its page or spread. */
function backToManuscript(ed: Editor): void {
  closeRewrite()
  if (ed.isDestroyed) return
  ed.view.dispatch(ed.state.tr.scrollIntoView())
  ed.view.focus()
}

/** The open re-write (or `id`), its passage now, and the manuscript editor; a notice and null when it cannot be resolved. */
function target(id?: string): { ed: Editor; record: RewriteRecord; range: { from: number; to: number } } | null {
  const rid = id ?? store().rewrite.openId
  flushLiveVersions()
  const record = rid ? getRewrite(rid) : undefined
  const ed = getEditor()
  if (!record || record.status !== 'open' || !ed || ed.isDestroyed) return null
  const range = passageRange(ed.state.doc, record.anchor)
  if (!range) {
    actions().setNotice({ kind: passageProblem(ed.state.doc, record.anchor) === 'split' ? 'split' : 'missing', id: record.anchor, seq: nextSeq() })
    return null
  }
  return { ed, record, range }
}

/** Indices of a passage's blocks that open a chapter (its title, or the chapter number before one). */
function chapterOpenings(doc: PMNode): ReadonlySet<number> {
  const starts = new Map<number, number>()
  doc.forEach((_n, offset, i) => starts.set(offset, i))
  const out = new Set<number>()
  for (const c of getChapters(doc, undefined, 'simple')) {
    const i = starts.get(c.from)
    if (i !== undefined) out.add(i)
  }
  return out
}

const plain = (n: PMNode) => norm(blockPlainText(n, { markupView: 'simple' }))
const quoted = (titles: string[]) => titles.map((t) => `“${t}”`).join(', ')

/** Where the passage [from, to) of `doc` is: block index, chapter, and the starts of its neighbours. */
function locationOf(doc: PMNode, from: number, to: number): RewriteLocation {
  const block = doc.resolve(from).index(0)
  const last = doc.resolve(Math.min(to, doc.content.size)).index(0)
  const text = (i: number) => (i >= 0 && i < doc.childCount ? plain(doc.child(i)).slice(0, 60) : '')
  const where = chapterOf(doc, getChapters(doc), from)
  return { block, chapter: where.index, before: text(block - 1), after: text(last), chapterTitle: where.title, offset: block - where.start }
}

/** The chapter holding `pos`: its index, title (normalized, 60 characters; '' before the first chapter) and first block index. */
function chapterOf(doc: PMNode, chapters: ReturnType<typeof getChapters>, pos: number): { index: number; title: string; start: number } {
  const index = chapterIndexAt(chapters, pos)
  const c = index >= 0 ? chapters[index] : null
  return { index, title: c ? norm(c.title).slice(0, 60) : '', start: c ? doc.resolve(c.from).index(0) : 0 }
}

function toNode(ed: Editor, json: DocNodeJSON): PMNode | null {
  try {
    const node = ed.schema.nodeFromJSON(json)
    node.check()
    return node
  } catch (err) {
    console.error('[rewrite] the version does not fit the schema; nothing was changed', err)
    return null
  }
}

/** The version Keep This Version keeps: `versionId`, else the one on the revised page. */
function chosenVersion(record: RewriteRecord, versionId?: string): string {
  const shown = store().rewrite.openId === record.id ? store().rewrite.activeVersionId : null
  const ids = record.versions.map((v) => v.id)
  for (const v of [versionId, shown, record.currentVersionId]) if (v && ids.includes(v)) return v
  return ids[ids.length - 1]
}

/**
 * Keep This Version (the one on the revised page, or `versionId`). Asks first when it would remove
 * or add a chapter title. Resolves true when the manuscript was updated.
 */
export async function keepVersion(versionId?: string, id?: string): Promise<boolean> {
  const t = target(id)
  if (!t) return false
  const vid = chosenVersion(t.record, versionId)
  const left = toNode(t.ed, currentPassageDoc(t.record) ?? t.record.original)
  const json = versionDoc(t.record, vid)
  const right = json ? toNode(t.ed, json) : null
  if (!left || !right) return false
  // Which chapter openings the version removes or adds, by position (a demoted title and a promoted one both count).
  const { removed, added } = chapterChanges(left, right, chapterOpenings)
  if (removed.length || added.length) {
    const gone = removed.map((i) => plain(left.child(i))).filter(Boolean)
    const fresh = added.map((i) => plain(right.child(i))).filter(Boolean)
    const parts: string[] = []
    if (removed.length) parts.push(`leaves out the chapter title${gone.length > 1 ? 's' : ''}${gone.length ? ` ${quoted(gone)}` : ''} (its chapter runs on from the one before it)`)
    if (added.length) parts.push(`makes ${fresh.length ? quoted(fresh) : 'a paragraph'} a chapter title (the chapter is split there)`)
    const ok = await confirmFn({
      title: removed.length && added.length ? 'Change the chapters?' : removed.length ? 'Remove a chapter title?' : 'Add a chapter title?',
      message: `This version ${parts.join(' and ')}. Keep this version anyway?`,
      confirmLabel: 'Keep This Version',
    })
    if (!ok) return false
  }
  return keepVersionNow(vid, t.record.id)
}

/** Keep This Version without asking (keepVersion asked already, tests). */
export function keepVersionNow(versionId: string, id?: string): boolean {
  const t = target(id)
  if (!t) return false
  const { ed, record, range } = t
  const json = versionDoc(record, versionId)
  const left = toNode(ed, currentPassageDoc(record) ?? record.original)
  const right = json ? toNode(ed, json) : null
  if (!left || !right) return false
  const state = ed.state
  let tr = state.tr
  // Track Changes: recorded here (the recorder would also take the anchor steps below for style changes).
  if (isTracking()) tr = trackedReplacement(state, range.from, left, right)
  else replacePassage(tr, range.from, left, right)
  if (!tr.getMeta(TRACKED_META)) tr.setMeta(TRACK_SKIP_META, true)
  const start = tr.mapping.map(range.from, -1)
  const location = locationOf(tr.doc, start, tr.mapping.map(range.to, 1))
  clearAnchor(tr, record.anchor)
  // The kept passage is frozen into the record: later edits of the version never change what was kept.
  tr.step(
    new RewriteStateStep(record.id, record.anchor, OPEN, {
      status: 'resolved',
      choice: versionId,
      resolvedAt: new Date().toISOString(),
      kept: json!,
      location,
    }),
  )
  const caret = start + 1
  dispatchAlone(ed, tr, caret)
  backToManuscript(ed)
  return true
}

/**
 * The replacement as tracked changes: one recorder pass over the whole edit (`trackTransaction`), exactly
 * as for an edit typed in the manuscript: each replaced word is its deleted text followed by the new text,
 * and the Keep is one deletion change and one insertion change (the recorder's own grouping), one undo
 * step. When it cannot be recorded, it is applied untracked with the recorder's warning.
 */
function trackedReplacement(state: EditorState, base: number, left: PMNode, right: PMNode): Transaction {
  const tr = state.tr
  replacePassage(tr, base, left, right)
  if (!tr.docChanged) return tr
  const tracked = trackTransaction(state, tr, currentTrackAuthor())
  if (tracked.getMeta(TRACK_FAILED_META)) useStore.getState().trackChangesActions.setNotice(TRACK_FAILED_NOTICE)
  return tracked
}

/** Keep Original: the passage stays as it is; the re-write is resolved (its versions kept). */
export function keepOriginal(id?: string): boolean {
  const t = target(id)
  if (!t) return false
  const { ed, record, range } = t
  const tr = ed.state.tr.setMeta(TRACK_SKIP_META, true)
  clearAnchor(tr, record.anchor)
  const location = locationOf(tr.doc, range.from, range.to)
  tr.step(new RewriteStateStep(record.id, record.anchor, OPEN, { status: 'resolved', choice: CHOICE_ORIGINAL, resolvedAt: new Date().toISOString(), location }))
  dispatchAlone(ed, tr, range.from + 1)
  backToManuscript(ed)
  return true
}

/**
 * Discard Re-write: the re-write and its versions are removed (undo brings them back); the passage
 * stays as it is. Works on an open re-write whose passage is missing too, and on a resolved one.
 */
export function discardRewrite(id?: string): boolean {
  const rid = id ?? store().rewrite.openId
  flushLiveVersions()
  const record = rid ? getRewrite(rid) : undefined
  const ed = getEditor()
  if (!record || !ed || ed.isDestroyed) return false
  const tr = ed.state.tr.setMeta(TRACK_SKIP_META, true)
  clearAnchor(tr, record.anchor)
  const index = store().rewrite.rewrites.findIndex((r) => r.id === record.id)
  tr.step(new RewriteStateStep(record.id, record.anchor, stateOf(record), null, record, index))
  const range = passageRange(ed.state.doc, record.anchor)
  const wasOpen = store().rewrite.openId === record.id
  dispatchAlone(ed, tr, range ? range.from + 1 : null)
  if (wasOpen) backToManuscript(ed)
  // Not asked first (undo brings it back): said so.
  actions().setNotice({ kind: 'discarded', seq: nextSeq() })
  return true
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

/** Reopen's search: the passage found, `ambiguous` (several places fit and none stands out), or null (nowhere close). */
export type LocateResult = { from: number; to: number } | { ambiguous: true } | null

/** How many blocks from the remembered place a candidate without matching neighbours may start. */
const NEAR_BLOCKS = 3

/**
 * Where the text a resolved re-write left in the manuscript is now (Reopen). Candidates: the runs of
 * top-level blocks with the kept text word for word, else the runs most like it (edited since);
 * never blocks of another open re-write. With the `hint` saved when it resolved (rewrites.json
 * `location`), a candidate must have the same neighbouring paragraphs, or else start within a few
 * blocks of the remembered place in the same chapter; without one (an older file), the match must
 * be the only one. Several candidates that fit equally: `ambiguous` (Novel does not guess). Null
 * when nothing is close.
 */
export function locatePassage(doc: PMNode, kept: PMNode, open: ReadonlySet<string> = new Set(), hint?: RewriteLocation): LocateResult {
  const n = kept.childCount
  if (n === 0 || n > doc.childCount) return null
  const want: string[] = []
  kept.forEach((b) => want.push(plain(b)))
  const blocks: PMNode[] = []
  const starts: number[] = []
  doc.forEach((b, offset) => {
    blocks.push(b)
    starts.push(offset)
  })
  const free = (i: number) => {
    for (let k = 0; k < n; k++) {
      const a = blocks[i + k].attrs[REWRITE_BLOCK_ATTR] as string | null
      if (a && open.has(a)) return false
    }
    return true
  }
  const text = new Map<number, string>()
  const textAt = (i: number) => {
    let t = text.get(i)
    if (t === undefined) text.set(i, (t = plain(blocks[i])))
    return t
  }
  const range = (i: number) => ({ from: starts[i], to: starts[i + n - 1] + blocks[i + n - 1].nodeSize })

  const candidates: { i: number; score: number }[] = []
  for (let i = 0; i + n <= blocks.length; i++) {
    if (textAt(i) !== want[0]) continue
    let k = 1
    while (k < n && textAt(i + k) === want[k]) k++
    if (k === n && free(i)) candidates.push({ i, score: 1 })
  }
  if (!candidates.length) {
    // Edited since: runs whose blocks are alike (the first block alike enough to start one).
    for (let i = 0; i + n <= blocks.length; i++) {
      if (similarity(blocks[i], kept.child(0)) < 0.5) continue
      let sum = 0
      for (let k = 0; k < n; k++) sum += similarity(blocks[i + k], kept.child(k))
      if (sum / n >= 0.6 && free(i)) candidates.push({ i, score: sum / n })
    }
  }
  if (!candidates.length) return null

  const one = (list: { i: number; score: number }[]): LocateResult => {
    if (list.length === 1) return range(list[0].i)
    // The clearly best of several edited runs; equal ones are ambiguous.
    const sorted = [...list].sort((a, b) => b.score - a.score)
    if (sorted[0].score < 1 && sorted[0].score - sorted[1].score >= 0.1) return range(sorted[0].i)
    return { ambiguous: true }
  }
  // The kept text word for word, once in the whole book: that is it, wherever the edits since moved it.
  if (candidates.length === 1 && candidates[0].score === 1) return range(candidates[0].i)
  if (!hint) return one(candidates)

  // The hint ranks the candidates: neighbouring paragraphs (each one counts), then the chapter (by its title,
  // so chapters added or removed earlier do not matter), then the place in that chapter (blocks from its start).
  const chapters = getChapters(doc)
  const rank = (i: number) => {
    const where = chapterOf(doc, chapters, starts[i])
    const before = (i > 0 ? textAt(i - 1).slice(0, 60) : '') === hint.before
    const after = (i + n < blocks.length ? textAt(i + n).slice(0, 60) : '') === hint.after
    const chapter = hint.chapterTitle !== undefined ? where.title === hint.chapterTitle : where.index === hint.chapter
    const offset = hint.offset !== undefined ? i - where.start - hint.offset : i - hint.block
    const near = chapter && Math.abs(offset) <= Math.max(NEAR_BLOCKS, n)
    return (+before + +after) * 4 + +chapter * 2 + +near
  }
  const ranked = candidates.map((c) => ({ ...c, rank: rank(c.i) }))
  const top = Math.max(...ranked.map((c) => c.rank))
  // Nothing about any of them matches where the passage was: not close.
  if (top === 0) return null
  const best = ranked.filter((c) => c.rank === top)
  return one(best)
}

/** The passage a resolved re-write left in the manuscript: the frozen kept copy, else the version chosen, else the original. */
function keptText(record: RewriteRecord): DocNodeJSON {
  if (record.kept) return record.kept
  if (record.choice && record.choice !== CHOICE_ORIGINAL) return versionDoc(record, record.choice) ?? record.original
  return record.original
}

/**
 * Reopen a resolved re-write (Re-writes list): its passage is found in the manuscript (locatePassage)
 * and becomes the new original, compared with the saved versions; the passage is locked again. One
 * undo event, like the choice it reopens. A notice, and nothing locked, when the text is not found or
 * fits more than one place.
 */
export function reopenRewrite(id: string): boolean {
  const record = getRewrite(id)
  const ed = getEditor()
  if (!record || record.status === 'open' || !ed || ed.isDestroyed) return false
  if (store().rewrite.openId) closeRewrite({ restore: false })
  const kept = toNode(ed, keptText(record))
  const found = kept ? locatePassage(ed.state.doc, kept, openAnchorsIn(ed.state), record.location) : null
  if (!found || 'ambiguous' in found) {
    // The list closes, so the notice can be read.
    actions().setListOpen(false)
    actions().setNotice({ kind: 'notFound', ...(found ? { ambiguous: true } : {}), seq: nextSeq() })
    return false
  }
  const blocks: DocNodeJSON[] = []
  const tr = ed.state.tr.setMeta(TRACK_SKIP_META, true)
  ed.state.doc.nodesBetween(found.from, found.to, (node, pos) => {
    if (pos < found.from) return true
    blocks.push(compact(node))
    if ((ANCHOR_TYPES as readonly string[]).includes(node.type.name)) tr.setNodeAttribute(pos, REWRITE_BLOCK_ATTR, record.anchor)
    return false
  })
  tr.step(new RewriteStateStep(record.id, record.anchor, stateOf(record, true), { status: 'open', choice: null, original: passageDoc(blocks) }))
  // The manuscript gives up the focus first (as Re-write Passage… does: a long selection is not re-placed).
  if (ed.view.hasFocus()) {
    ;(ed.view.dom as HTMLElement).blur()
    globalThis.getSelection?.()?.removeAllRanges()
  }
  dispatchAlone(ed, tr, null)
  if (getRewrite(id)?.status !== 'open') return false
  const shown = record.choice && record.choice !== CHOICE_ORIGINAL && record.versions.some((v) => v.id === record.choice) ? record.choice : undefined
  return openRewrite(id, shown)
}

/** Keep commands: the open re-write can be resolved (its passage is in the manuscript in one piece). */
export function canChoose(): boolean {
  const id = store().rewrite.openId
  const r = id ? getRewrite(id) : undefined
  return !!r && r.status === 'open' && !store().rewrite.problems[r.anchor]
}
