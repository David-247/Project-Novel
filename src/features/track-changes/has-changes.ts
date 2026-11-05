import type { Node as PMNode } from '@tiptap/pm/model'
import { TRACKING_BLOCK_ATTRS, TRACKING_MARKS } from '@/shared/track-changes'

const tracked = new WeakMap<PMNode, boolean>()
const own = (n: PMNode) => n.marks.some((m) => TRACKING_MARKS.includes(m.type.name)) || TRACKING_BLOCK_ATTRS.some((a) => n.attrs[a] != null)

/**
 * The node, or anything inside it, carries a tracked change. Cached per (immutable) container node,
 * recursively: after an edit only the path to the edited block is walked again, so asking about a
 * whole new document is O(depth × siblings), not O(document).
 */
export function hasTrackedChanges(node: PMNode): boolean {
  if (node.isLeaf) return own(node)
  let v = tracked.get(node)
  if (v !== undefined) return v
  v = own(node)
  for (let i = 0; !v && i < node.childCount; i++) if (hasTrackedChanges(node.child(i))) v = true
  tracked.set(node, v)
  return v
}
