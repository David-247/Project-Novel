import type { Node as PMNode } from '@tiptap/pm/model'
import { TRACKING_BLOCK_ATTRS, TRACKING_MARKS } from '@/shared/track-changes'

const tracked = new WeakMap<PMNode, boolean>()
/** The node, or anything inside it, carries a tracked change. Cached per (immutable) node. */
export function hasTrackedChanges(node: PMNode): boolean {
  let v = tracked.get(node)
  if (v !== undefined) return v
  const own = (n: PMNode) => n.marks.some((m) => TRACKING_MARKS.includes(m.type.name)) || TRACKING_BLOCK_ATTRS.some((a) => n.attrs[a] != null)
  v = own(node)
  if (!v && !node.isLeaf)
    node.descendants((n) => {
      if (v) return false
      if (own(n)) v = true
      return !v
    })
  tracked.set(node, v)
  return v
}
