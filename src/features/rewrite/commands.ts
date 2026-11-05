import type { Node as PMNode } from '@tiptap/pm/model'
import { TextSelection } from '@tiptap/pm/state'
import { chapterIndexAt, getChapters, getEditor } from '@/features/editor'
import { sideFileChanged } from '@/features/storage'
import type { DocNodeJSON } from '@/shared/document'
import { REWRITE_BLOCK_ATTR } from '@/shared/rewrite'
import { useStore, type RewriteRecord, type RewriteVersion } from '@/shared/store'
import {
  passageRange,
  setAnchor,
  setOriginalChangedHandler,
  setRewriteShortcutHandler,
  setSideBarClickHandler,
} from './anchor'
import { cleanVersionName, newRewriteId, nextVersionName, passageDoc } from './model'

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
const nextSeq = () => ++noticeSeq

/** The open comparison view registers itself here (flush the revision being typed, focus a page). */
export interface LiveView {
  flush(): void
  focus(side: 'left' | 'right'): void
}
let live: LiveView | null = null
export function setLiveView(v: LiveView | null): void {
  live = v
}

/** Host hooks: remember / restore the manuscript's scroll position around the view. */
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
function compact(node: PMNode): DocNodeJSON {
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

/** Re-write Passage…: the selection widened to whole paragraphs (or the paragraph at the caret). */
export function rewritePassage(): boolean {
  const ed = getEditor()
  if (!ed || ed.isDestroyed || store().rewrite.openId) return false
  const { state } = ed
  const doc = state.doc
  const [first, last] = selectedBlocks(doc, state.selection.from, state.selection.to)
  let from = 0
  for (let i = 0; i < first; i++) from += doc.child(i).nodeSize
  let to = from
  const blocks: PMNode[] = []
  for (let i = first; i <= last; i++) {
    blocks.push(doc.child(i))
    to += doc.child(i).nodeSize
  }
  // A passage already in an open re-write (any block of the selection): open that one.
  const openAnchors = new Map(store().rewrite.rewrites.filter((r) => r.status === 'open').map((r) => [r.anchor, r.id]))
  for (const b of blocks) {
    const existing = openAnchors.get(b.attrs[REWRITE_BLOCK_ATTR] as string)
    if (existing) return openRewrite(existing)
  }
  // At most one chapter (decision 4ec247fc): the selection must not cross a chapter start.
  const chapters = getChapters(doc)
  const lastStart = to - blocks[blocks.length - 1].nodeSize
  if (chapterIndexAt(chapters, from) !== chapterIndexAt(chapters, lastStart)) {
    actions().setNotice({ kind: 'span', seq: nextSeq() })
    return false
  }
  const id = newRewriteId()
  const now = new Date().toISOString()
  const original = passageDoc(blocks.map(compact))
  const version: RewriteVersion = { id: newRewriteId('v'), name: 'Version 1', doc: original, updatedAt: now }
  const record: RewriteRecord = { id, createdAt: now, anchor: id, original, versions: [version], currentVersionId: version.id, status: 'open' }
  actions().changed([...store().rewrite.rewrites, record])
  ed.view.dispatch(setAnchor(state.tr, from, to, id))
  sideFileChanged()
  return openRewrite(id)
}

/** Open the comparison view on re-write `id` (its last viewed version, or `versionId`). */
export function openRewrite(id: string, versionId?: string): boolean {
  const r = getRewrite(id)
  if (!r) return false
  const vid = versionId && r.versions.some((v) => v.id === versionId) ? versionId : (r.currentVersionId ?? r.versions[r.versions.length - 1].id)
  if (store().rewrite.openId === id) {
    selectVersion(vid)
    return true
  }
  if (store().rewrite.openId) closeRewrite({ restore: false })
  else hooks.beforeOpen?.()
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
    actions().setNotice({ kind: 'missing', seq: nextSeq() })
    return false
  }
  closeRewrite()
  const sel = TextSelection.near(ed.state.doc.resolve(range.from + 1))
  ed.view.dispatch(ed.state.tr.setSelection(sel).scrollIntoView())
  ed.view.focus()
  return true
}

/** Wire the manuscript's anchor plugin to these actions (once, at start). Returns unwire. */
export function wireRewriteAnchors(): () => void {
  setOriginalChangedHandler(markOriginalChanged)
  setSideBarClickHandler((anchor) => {
    const r = store().rewrite.rewrites.find((x) => x.anchor === anchor && x.status === 'open')
    if (r) openRewrite(r.id)
  })
  setRewriteShortcutHandler(() => {
    rewritePassage()
    return true
  })
  return () => {
    setOriginalChangedHandler(null)
    setSideBarClickHandler(null)
    setRewriteShortcutHandler(null)
  }
}
