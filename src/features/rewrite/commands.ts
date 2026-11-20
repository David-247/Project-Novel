import type { Node as PMNode, Schema } from '@tiptap/pm/model'
import { TextSelection, type Transaction } from '@tiptap/pm/state'
import { closeHistory } from '@tiptap/pm/history'
import { Transform } from '@tiptap/pm/transform'
import { chapterIndexAt, getChapters, getEditor, onStyleDeleted, type StyleRemap } from '@/features/editor'
import { revealPosition } from '@/features/pagination'
import { sideFileChanged } from '@/features/storage'
import type { DocNodeJSON } from '@/shared/document'
import { REWRITE_BLOCK_ATTR } from '@/shared/rewrite'
import { useStore, type RewriteRecord, type RewriteVersion } from '@/shared/store'
import {
  passageProblem,
  passageRange,
  setAnchor,
  setOriginalChangedHandler,
  setRewriteShortcutHandler,
  setSideBarClickHandler,
  setStateStepsMirroredHandler,
} from './anchor'
import { cleanVersionName, newRewriteId, nextVersionName, passageDoc, withoutAnchor } from './model'

/**
 * Re-write actions (docs/design.md, "Re-write"). The data model (store `rewrite`, rewrites.json):
 * one RewriteRecord per passage, its `original` snapshot and its versions as passage docs
 * (`{ type: 'doc', content: [blocks] }`). T9 (keep original / keep this version) builds on:
 * - getRewrite(id), passageRange(doc, record.anchor): where the passage is in the manuscript now;
 * - versionDoc(record, versionId) after flushLiveVersions(): the version's blocks;
 * - one manuscript transaction replacing [from, to) with them, carrying REWRITE_ALLOW_META (passes
 *   the lock; undoable as one step), then status 'resolved' (the anchor no longer locks).
 */

const store = () => useStore.getState()
const actions = () => useStore.getState().rewriteActions

let noticeSeq = 0
export const nextSeq = (): number => ++noticeSeq

/** The open comparison view registers itself here (flush the revision being typed, focus a page). */
export interface LiveView {
  flush(): void
  focus(side: 'left' | 'right'): void
  /** Re-map a deleted style in every version the view holds (each keeps its undo history), then flush. */
  remapStyle?(remap: StyleRemap): void
}
let live: LiveView | null = null
export function setLiveView(v: LiveView | null): void {
  live = v
}

/** Host hooks around the view (the host gives the focus back to the manuscript after a close). */
let hooks: { beforeOpen?: () => void; afterClose?: () => void } = {}
export function setViewHooks(h: typeof hooks): () => void {
  hooks = h
  return () => {
    if (hooks === h) hooks = {}
  }
}

/** Copy the revision being typed (if any) into the store. Before saves, snapshots and T9's apply. */
export function flushLiveVersions(): void {
  live?.flush()
}

export function getRewrite(id: string): RewriteRecord | undefined {
  return store().rewrite.rewrites.find((r) => r.id === id)
}

export function versionDoc(record: RewriteRecord, versionId: string): DocNodeJSON | undefined {
  return record.versions.find((v) => v.id === versionId)?.doc
}

/** Replace one re-write (a user change). */
function update(id: string, fn: (r: RewriteRecord) => RewriteRecord): void {
  const list = store().rewrite.rewrites
  const i = list.findIndex((r) => r.id === id)
  if (i < 0) return
  const next = fn(list[i])
  if (next === list[i]) return
  const copy = list.slice()
  copy[i] = next
  actions().changed(copy)
  sideFileChanged()
}

/** The revised page's editor changed version `versionId`'s doc (called debounced, and on flush). */
export function storeVersionDoc(rewriteId: string, versionId: string, doc: DocNodeJSON): void {
  update(rewriteId, (r) => ({
    ...r,
    versions: r.versions.map((v) => (v.id === versionId ? { ...v, doc, updatedAt: new Date().toISOString() } : v)),
  }))
}

/** Block JSON without attributes at their schema default: what manuscript.json would hold. */
export function compact(node: PMNode): DocNodeJSON {
  const walk = (j: DocNodeJSON, n: PMNode): DocNodeJSON => {
    if (j.attrs) {
      const specs = (n.type.spec.attrs ?? {}) as Record<string, { default?: unknown }>
      const attrs = Object.fromEntries(Object.entries(j.attrs).filter(([k, v]) => !(k in specs) || specs[k].default !== v))
      if (Object.keys(attrs).length) j.attrs = attrs
      else delete j.attrs
    }
    if (j.content) n.forEach((c, _o, i) => void (j.content![i] = walk(j.content![i], c)))
    return j
  }
  return walk(node.toJSON() as DocNodeJSON, node)
}

/** The passage's blocks in the manuscript now, as a passage doc (anchors removed), or null. */
export function currentPassageDoc(record: RewriteRecord): DocNodeJSON | null {
  const ed = getEditor()
  if (!ed) return null
  const range = passageRange(ed.state.doc, record.anchor)
  if (!range) return null
  const blocks: DocNodeJSON[] = []
  ed.state.doc.nodesBetween(range.from, range.to, (node, pos) => {
    if (pos >= range.from) blocks.push(compact(node))
    return false
  })
  return passageDoc(blocks)
}

/** Top-level block index range [first, last] the selection covers (a selection ending at a block's very start leaves it out). */
function selectedBlocks(doc: PMNode, from: number, to: number): [number, number] {
  const $from = doc.resolve(from)
  const $to = doc.resolve(to)
  const first = $from.depth === 0 ? Math.min($from.index(0), doc.childCount - 1) : $from.index(0)
  let last = $to.depth === 0 ? Math.max(0, $to.index(0) - 1) : $to.index(0)
  if (to > from && $to.depth > 0 && $to.pos === $to.start(1) && last > first) last--
  return [first, Math.max(first, last)]
}

/** Why a passage cannot be made from a range: a chapter start inside it, or a block already in an open re-write. */
type PassageRefusal = { refused: 'span' } | { refused: 'locked'; existing: string } | { refused: 'refused' }

/**
 * Make top-level blocks `first..last` a new passage (the anchor set, one closed history group) and build
 * its re-write record, not yet stored or opened. At most one chapter (decision 4ec247fc); a block already
 * in an open re-write is refused with that re-write's id.
 */
function createPassage(first: number, last: number): { id: string; record: RewriteRecord } | PassageRefusal {
  const ed = getEditor()!
  const { state } = ed
  const doc = state.doc
  let from = 0
  for (let i = 0; i < first; i++) from += doc.child(i).nodeSize
  let to = from
  const blocks: PMNode[] = []
  for (let i = first; i <= last; i++) {
    blocks.push(doc.child(i))
    to += doc.child(i).nodeSize
  }
  const openAnchors = new Map(store().rewrite.rewrites.filter((r) => r.status === 'open').map((r) => [r.anchor, r.id]))
  for (const b of blocks) {
    const existing = openAnchors.get(b.attrs[REWRITE_BLOCK_ATTR] as string)
    if (existing) return { refused: 'locked', existing }
  }
  const chapters = getChapters(doc)
  const lastStart = to - blocks[blocks.length - 1].nodeSize
  if (chapterIndexAt(chapters, from) !== chapterIndexAt(chapters, lastStart)) return { refused: 'span' }
  const id = newRewriteId()
  const now = new Date().toISOString()
  const original = passageDoc(blocks.map(compact))
  const version: RewriteVersion = { id: newRewriteId('v'), name: 'Version 1', doc: original, updatedAt: now }
  const record: RewriteRecord = { id, createdAt: now, anchor: id, original, versions: [version], currentVersionId: version.id, status: 'open' }
  // The anchor first (a filtered dispatch must not leave a record without a passage). Undo never merges
  // edits from before the re-write with later ones (the history group is closed).
  // The manuscript gives up the focus first: with its selection in the DOM, redrawing the passage's
  // blocks would make the browser lay the whole manuscript out again to re-place a long selection
  // (over 200 ms for a chapter). Its selection stays in the editor state; closing focuses it again.
  if (ed.view.hasFocus()) {
    ;(ed.view.dom as HTMLElement).blur()
    globalThis.getSelection?.()?.removeAllRanges()
  }
  ed.view.dispatch(closeHistory(setAnchor(state.tr, from, to, id)))
  if (ed.state.doc.nodeAt(from)?.attrs[REWRITE_BLOCK_ATTR] !== id) {
    // Refused: back to the manuscript, selection as it was.
    ed.view.focus()
    return { refused: 'refused' }
  }
  return { id, record }
}

/** Re-write Passage…: the selection widened to whole paragraphs (or the paragraph at the caret). */
export function rewritePassage(): boolean {
  const ed = getEditor()
  if (!ed || ed.isDestroyed || store().rewrite.openId) return false
  const { selection, doc } = ed.state
  const [first, last] = selectedBlocks(doc, selection.from, selection.to)
  const made = createPassage(first, last)
  if ('refused' in made) {
    // A passage already in an open re-write (any block of the selection): open that one.
    if (made.refused === 'locked') return openRewrite(made.existing)
    if (made.refused === 'span') actions().setNotice({ kind: 'span', seq: nextSeq() })
    return false
  }
  actions().changed([...store().rewrite.rewrites, made.record])
  sideFileChanged()
  return openRewrite(made.id)
}

export type RewriteWithVersionResult =
  | { ok: true; rewriteId: string; versionId: string }
  /**
   * span: the range crosses a chapter start; locked: part of it is in an open re-write; open: the view is
   * open; refused: no manuscript, or the reviser failed.
   */
  | { ok: false; reason: 'span' | 'locked' | 'open' | 'refused' }

/**
 * A re-write of the whole top-level blocks `range` touches, opened on a ready-made version (the AI
 * tutor's proposals, Phase 5): Re-write Passage on that range, then a version holding the revision.
 * `versionDoc` is the version's passage doc, or a reviser that edits a scratch transaction of the
 * manuscript as it is now (never dispatched; false refuses), whose passage blocks become the version.
 * The writer then decides with Keep Original, Keep This Version or Discard. Nothing changes on a refusal.
 */
export function openRewriteWithVersion(
  range: { from: number; to: number },
  versionDoc: DocNodeJSON | ((tr: Transaction) => boolean),
  versionName = 'Tutor suggestion',
): RewriteWithVersionResult {
  const ed = getEditor()
  if (!ed || ed.isDestroyed) return { ok: false, reason: 'refused' }
  if (store().rewrite.openId) return { ok: false, reason: 'open' }
  const doc = ed.state.doc
  const lo = Math.max(0, Math.min(range.from, range.to, doc.content.size))
  const hi = Math.min(doc.content.size, Math.max(range.from, range.to))
  const [first, last] = selectedBlocks(doc, lo, hi)
  // The version first, from the manuscript before the anchor is set (a refusal leaves no trace).
  let version: DocNodeJSON
  if (typeof versionDoc === 'function') {
    const tr = ed.state.tr
    if (!versionDoc(tr)) return { ok: false, reason: 'refused' }
    let from = 0
    for (let i = 0; i < first; i++) from += doc.child(i).nodeSize
    let to = from
    for (let i = first; i <= last; i++) to += doc.child(i).nodeSize
    const a = tr.mapping.map(from, -1)
    const b = tr.mapping.map(to, 1)
    const blocks: DocNodeJSON[] = []
    tr.doc.nodesBetween(a, b, (node, pos) => {
      if (pos >= a && pos + node.nodeSize <= b) blocks.push(compact(node))
      return false
    })
    if (!blocks.length) return { ok: false, reason: 'refused' }
    version = withoutAnchors(passageDoc(blocks))
  } else version = withoutAnchors(versionDoc)
  const made = createPassage(first, last)
  if ('refused' in made) return { ok: false, reason: made.refused }
  const v: RewriteVersion = { id: newRewriteId('v'), name: cleanVersionName(versionName, 'Tutor suggestion'), doc: version, updatedAt: new Date().toISOString() }
  actions().changed([...store().rewrite.rewrites, { ...made.record, versions: [...made.record.versions, v], currentVersionId: v.id }])
  sideFileChanged()
  if (!openRewrite(made.id, v.id)) return { ok: false, reason: 'refused' }
  return { ok: true, rewriteId: made.id, versionId: v.id }
}

/** A passage doc's blocks without a re-write anchor (a version never carries one). */
function withoutAnchors(doc: DocNodeJSON): DocNodeJSON {
  return { ...doc, content: (doc.content ?? []).map(withoutAnchor) }
}

/** Open the comparison view on re-write `id` (its last viewed version, or `versionId`). */
export function openRewrite(id: string, versionId?: string): boolean {
  const r = getRewrite(id)
  // A resolved re-write is reopened through its history step (choice.ts, reopenRewrite).
  if (!r || r.status !== 'open') return false
  const vid = versionId && r.versions.some((v) => v.id === versionId) ? versionId : (r.currentVersionId ?? r.versions[r.versions.length - 1].id)
  if (store().rewrite.openId === id) {
    selectVersion(vid)
    return true
  }
  if (store().rewrite.openId) closeRewrite({ restore: false })
  else hooks.beforeOpen?.()
  // Find & Replace acts on the manuscript, which the view hides: it closes (it is off while the view is open).
  store().findActions.closePanel()
  actions().open(id, vid)
  return true
}

/** Close the view: the re-write stays saved as a draft; back to the manuscript. */
export function closeRewrite({ restore = true }: { restore?: boolean } = {}): void {
  if (!store().rewrite.openId) return
  live?.flush()
  actions().close()
  if (restore) hooks.afterClose?.()
}

/** Open re-writes in manuscript order (by where their passage starts; missing passages last). */
function ordered(): { id: string; at: number }[] {
  const doc = getEditor()?.state.doc
  return store()
    .rewrite.rewrites.filter((r) => r.status === 'open')
    .map((r) => ({ id: r.id, at: doc ? (passageRange(doc, r.anchor)?.from ?? Number.MAX_SAFE_INTEGER) : 0 }))
    .sort((a, b) => a.at - b.at)
}

/** Next / Previous Re-write: from the open one, else from the manuscript's caret; wraps. */
export function stepRewrite(dir: 1 | -1): boolean {
  const list = ordered()
  if (!list.length) return false
  const openId = store().rewrite.openId
  let i: number
  if (openId) {
    const k = list.findIndex((e) => e.id === openId)
    i = (k + dir + list.length) % list.length
  } else {
    const caret = getEditor()?.state.selection.from ?? 0
    i = dir > 0 ? list.findIndex((e) => e.at > caret) : list.map((e) => e.at < caret).lastIndexOf(true)
    if (i < 0) i = dir > 0 ? 0 : list.length - 1
  }
  return openRewrite(list[i].id)
}

export const hasOpenRewrites = (): boolean => store().rewrite.rewrites.some((r) => r.status === 'open')
export const isViewOpen = (): boolean => store().rewrite.openId !== null

/** Show version `versionId` on the revised page (remembered as the one to reopen on). */
export function selectVersion(versionId: string): void {
  const id = store().rewrite.openId
  const r = id ? getRewrite(id) : undefined
  if (!r || !r.versions.some((v) => v.id === versionId)) return
  live?.flush()
  actions().setActiveVersion(versionId)
  actions().setNarrowSide('revised')
  if (r.currentVersionId !== versionId) update(r.id, (x) => ({ ...x, currentVersionId: versionId }))
}

/** New Version: a copy of the version on the revised page, shown at once. Returns its id. */
export function newVersion(): string | null {
  const id = store().rewrite.openId
  const r = id ? getRewrite(id) : undefined
  if (!r) return null
  live?.flush()
  const fresh = getRewrite(r.id)!
  const from = fresh.versions.find((v) => v.id === store().rewrite.activeVersionId) ?? fresh.versions[fresh.versions.length - 1]
  const v: RewriteVersion = { id: newRewriteId('v'), name: nextVersionName(fresh.versions), doc: from.doc, updatedAt: new Date().toISOString() }
  update(r.id, (x) => ({ ...x, versions: [...x.versions, v], currentVersionId: v.id }))
  actions().setActiveVersion(v.id)
  actions().setNarrowSide('revised')
  return v.id
}

export function renameVersion(versionId: string, name: string): void {
  const id = store().rewrite.openId
  if (!id) return
  update(id, (r) => {
    const v = r.versions.find((x) => x.id === versionId)
    if (!v) return r
    const clean = cleanVersionName(name, v.name)
    return clean === v.name ? r : { ...r, versions: r.versions.map((x) => (x.id === versionId ? { ...x, name: clean } : x)) }
  })
}

export const toggleShowDiff = (): void => actions().setShowDiff(!store().rewrite.showDiff)
export const toggleFlip = (): void => actions().setFlipped(!store().rewrite.flipped)
export const toggleShowCurrent = (): void => actions().setShowCurrent(!store().rewrite.showCurrent)

/** Mod-Alt-Left / Right: focus the page on that side (original or revision, following Flip). */
export function focusSide(side: 'left' | 'right'): void {
  live?.focus(side)
}

/** Focus the revision, whichever side it is on. */
export function focusRevision(): void {
  live?.focus(store().rewrite.flipped ? 'left' : 'right')
}

/** A programmatic edit (Replace All, accept / reject, undo) changed the passage of `anchor`. */
export function markOriginalChanged(anchor: string): void {
  const r = store().rewrite.rewrites.find((x) => x.anchor === anchor && x.status === 'open')
  if (!r || r.originalChanged) return
  update(r.id, (x) => ({ ...x, originalChanged: true }))
}

/** `json` (a passage doc) with a deleted style re-mapped; `json` itself when nothing changes or it does not fit the schema. */
function remapPassageDoc(schema: Schema, json: DocNodeJSON, remap: StyleRemap): DocNodeJSON {
  let tr: Transform
  try {
    tr = new Transform(schema.nodeFromJSON(json))
  } catch {
    return json
  }
  remap(tr)
  return tr.docChanged ? compact(tr.doc) : json
}

/**
 * A style was deleted (Format > Manage Styles): the manuscript is re-mapped by the editor slice; here
 * every re-write follows, open or resolved (the original, each version, the kept copy) and the open
 * revision, so neither Keep nor Reopen nor a later Keep Original brings the deleted style back.
 */
export function remapRewriteStyles(remap: StyleRemap): void {
  const schema = getEditor()?.schema
  if (!schema) return
  // The revision being typed first (it keeps its undo history); its versions are then in the store.
  live?.remapStyle?.(remap)
  const list = store().rewrite.rewrites
  let changed = false
  const next = list.map((r) => {
    const original = remapPassageDoc(schema, r.original, remap)
    const kept = r.kept ? remapPassageDoc(schema, r.kept, remap) : undefined
    let versionsChanged = false
    const versions = r.versions.map((v) => {
      const doc = remapPassageDoc(schema, v.doc, remap)
      if (doc === v.doc) return v
      versionsChanged = true
      return { ...v, doc }
    })
    if (original === r.original && kept === r.kept && !versionsChanged) return r
    changed = true
    return { ...r, original, versions, ...(kept ? { kept } : {}) }
  })
  if (!changed) return
  actions().changed(next)
  sideFileChanged()
}

export function dismissNotice(): void {
  actions().setNotice(null)
}

export function openList(open = true): void {
  actions().setListOpen(open)
}

/** Put the manuscript's caret at the start of the passage (closing the view first). */
export function goToPassage(id: string): boolean {
  const r = getRewrite(id)
  const ed = getEditor()
  if (!r || !ed) return false
  const range = passageRange(ed.state.doc, r.anchor)
  if (!range) {
    actions().setNotice({ kind: passageProblem(ed.state.doc, r.anchor) === 'split' ? 'split' : 'missing', seq: nextSeq() })
    return false
  }
  closeRewrite()
  const sel = TextSelection.near(ed.state.doc.resolve(range.from + 1))
  ed.view.dispatch(ed.state.tr.setSelection(sel).scrollIntoView())
  ed.view.focus()
  // Book mode turns to the passage's spread (continuous scroll centres it), as Next Comment does.
  revealPosition(sel.from)
  return true
}

/** Wire the manuscript's anchor plugin to these actions (once, at start). Returns unwire. */
export function wireRewriteAnchors(): () => void {
  setOriginalChangedHandler(markOriginalChanged)
  // Keep / Discard / Reopen (and their undo / redo) changed the re-writes: rewrites.json is unsaved.
  setStateStepsMirroredHandler(() => {
    sideFileChanged()
    // The open view's re-write was resolved or removed (an undo, a redo): back to the manuscript.
    const openId = store().rewrite.openId
    if (openId && getRewrite(openId)?.status !== 'open') closeRewrite()
  })
  setSideBarClickHandler((anchor) => {
    const r = store().rewrite.rewrites.find((x) => x.anchor === anchor && x.status === 'open')
    if (r) openRewrite(r.id)
  })
  setRewriteShortcutHandler(() => {
    rewritePassage()
    return true
  })
  const offStyles = onStyleDeleted((_id, remap) => remapRewriteStyles(remap))
  return () => {
    offStyles()
    setOriginalChangedHandler(null)
    setStateStepsMirroredHandler(null)
    setSideBarClickHandler(null)
    setRewriteShortcutHandler(null)
  }
}
