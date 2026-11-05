import type { Node as PMNode } from '@tiptap/pm/model'
import { TextSelection, type Transaction } from '@tiptap/pm/state'
import { closeHistory } from '@tiptap/pm/history'
import type { Editor } from '@tiptap/core'
import { blockPlainText, getChapters, getEditor } from '@/features/editor'
import { currentTrackAuthor, isTracking, trackTransaction, TRACK_SKIP_META } from '@/features/track-changes'
import type { DocNodeJSON } from '@/shared/document'
import { REWRITE_BLOCK_ATTR } from '@/shared/rewrite'
import { useStore, type RewriteRecord } from '@/shared/store'
import { similarity } from './align'
import { ANCHOR_TYPES, openAnchorsIn, passageProblem, passageRange, REWRITE_ALLOW_META } from './anchor'
import { replacePassage } from './apply'
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

const chapterTitles = (doc: PMNode) => getChapters(doc, undefined, 'simple')

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
  const before = chapterTitles(left)
  const after = chapterTitles(right)
  if (before.length !== after.length) {
    const removed = before.find((c) => !after.some((a) => a.title === c.title)) ?? before[0]
    const ok = await confirmFn(
      after.length < before.length
        ? {
            title: 'Remove a chapter title?',
            message: `This version leaves out the chapter title${removed?.title ? ` “${removed.title}”` : ''}. Its chapter will run on from the one before it. Keep this version anyway?`,
            confirmLabel: 'Keep This Version',
          }
        : {
            title: 'Add a chapter title?',
            message: 'This version adds a chapter title, so the chapter will be split in two. Keep this version anyway?',
            confirmLabel: 'Keep This Version',
          },
    )
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
  replacePassage(tr, range.from, left, right)
  // Track Changes: recorded here (the recorder would also take the anchor steps below for style changes).
  if (tr.docChanged && isTracking()) tr = trackTransaction(state, tr, currentTrackAuthor())
  else tr.setMeta(TRACK_SKIP_META, true)
  const caret = tr.mapping.map(range.from, -1) + 1
  clearAnchor(tr, record.anchor)
  tr.step(new RewriteStateStep(record.id, record.anchor, OPEN, { status: 'resolved', choice: versionId, resolvedAt: new Date().toISOString() }))
  dispatchAlone(ed, tr, caret)
  backToManuscript(ed)
  return true
}

/** Keep Original: the passage stays as it is; the re-write is resolved (its versions kept). */
export function keepOriginal(id?: string): boolean {
  const t = target(id)
  if (!t) return false
  const { ed, record, range } = t
  const tr = ed.state.tr.setMeta(TRACK_SKIP_META, true)
  clearAnchor(tr, record.anchor)
  tr.step(new RewriteStateStep(record.id, record.anchor, OPEN, { status: 'resolved', choice: CHOICE_ORIGINAL, resolvedAt: new Date().toISOString() }))
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
  const before: RewriteStepState = { status: record.status, choice: record.choice ?? null, ...(record.resolvedAt ? { resolvedAt: record.resolvedAt } : {}) }
  tr.step(new RewriteStateStep(record.id, record.anchor, before, null, record))
  const range = passageRange(ed.state.doc, record.anchor)
  const wasOpen = store().rewrite.openId === record.id
  dispatchAlone(ed, tr, range ? range.from + 1 : null)
  if (wasOpen) backToManuscript(ed)
  return true
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

/**
 * Where the text a resolved re-write left in the manuscript is now: the run of top-level blocks with
 * the kept text (the version kept, or the original), word for word; else the most similar run (the
 * text was edited since). Never a block of another open re-write. Null when nothing is close.
 */
export function locatePassage(doc: PMNode, kept: PMNode, open: ReadonlySet<string> = new Set()): { from: number; to: number } | null {
  const n = kept.childCount
  if (n === 0 || n > doc.childCount) return null
  const want: string[] = []
  kept.forEach((b) => want.push(norm(blockPlainText(b, { markupView: 'simple' }))))
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
    if (t === undefined) text.set(i, (t = norm(blockPlainText(blocks[i], { markupView: 'simple' }))))
    return t
  }
  const range = (i: number) => ({ from: starts[i], to: starts[i + n - 1] + blocks[i + n - 1].nodeSize })
  for (let i = 0; i + n <= blocks.length; i++) {
    if (textAt(i) !== want[0]) continue
    let k = 1
    while (k < n && textAt(i + k) === want[k]) k++
    if (k === n && free(i)) return range(i)
  }
  // Edited since: the run whose blocks are most alike (the first block alike enough to start one).
  let best = -1
  let score = 0.6
  for (let i = 0; i + n <= blocks.length; i++) {
    if (similarity(blocks[i], kept.child(0)) < 0.5) continue
    let sum = 0
    for (let k = 0; k < n; k++) sum += similarity(blocks[i + k], kept.child(k))
    if (sum / n > score && free(i)) {
      score = sum / n
      best = i
    }
  }
  return best >= 0 ? range(best) : null
}

/**
 * Reopen a resolved re-write (Re-writes list): its passage is found in the manuscript (locatePassage)
 * and becomes the new original, compared with the saved versions; the passage is locked again. One
 * undo event, like the choice it reopens. A notice when the text is not found.
 */
export function reopenRewrite(id: string): boolean {
  const record = getRewrite(id)
  const ed = getEditor()
  if (!record || record.status === 'open' || !ed || ed.isDestroyed) return false
  if (store().rewrite.openId) closeRewrite({ restore: false })
  const keptJSON = record.choice && record.choice !== CHOICE_ORIGINAL ? (versionDoc(record, record.choice) ?? record.original) : record.original
  const kept = toNode(ed, keptJSON)
  const found = kept ? locatePassage(ed.state.doc, kept, openAnchorsIn(ed.state)) : null
  if (!found) {
    actions().setNotice({ kind: 'notFound', seq: nextSeq() })
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
  const before: RewriteStepState = { status: record.status, choice: record.choice ?? null, original: record.original, ...(record.resolvedAt ? { resolvedAt: record.resolvedAt } : {}) }
  tr.step(new RewriteStateStep(record.id, record.anchor, before, { status: 'open', choice: null, original: passageDoc(blocks) }))
  // The manuscript gives up the focus first (as Re-write Passage… does: a long selection is not re-placed).
  if (ed.view.hasFocus()) {
    ;(ed.view.dom as HTMLElement).blur()
    globalThis.getSelection?.()?.removeAllRanges()
  }
  dispatchAlone(ed, tr, null)
  if (getRewrite(id)?.status !== 'open') return false
  return openRewrite(id, record.choice && record.choice !== CHOICE_ORIGINAL ? record.choice : undefined)
}

/** Keep commands: the open re-write can be resolved (its passage is in the manuscript in one piece). */
export function canChoose(): boolean {
  const id = store().rewrite.openId
  const r = id ? getRewrite(id) : undefined
  return !!r && r.status === 'open' && !store().rewrite.problems[r.anchor]
}
