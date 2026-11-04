import { Fragment, Slice, type Node as PMNode } from '@tiptap/pm/model'
import { hidesInsertions, isInlineHidden, type MarkupView } from '@/shared/track-changes'
import { cleanSlice } from './record'

function visibleFragment(frag: Fragment, view: MarkupView): Fragment {
  let changed = false
  const out: PMNode[] = []
  frag.forEach((n) => {
    if (n.isInline && isInlineHidden(n, view)) {
      changed = true
      return
    }
    if (n.isText || n.isLeaf) return void out.push(n)
    const content = visibleFragment(n.content, view)
    if (content !== n.content) changed = true
    out.push(content === n.content ? n : n.copy(content))
  })
  return changed ? Fragment.fromArray(out) : frag
}

/**
 * What a copy (or cut, or drag) takes from the manuscript: the final text, without deleted text and
 * without any tracking marks or attributes, in every view but Original, which copies the original
 * text (the deleted text kept, the inserted text left out). Word copies the same.
 */
export function copiedSlice(slice: Slice, view: MarkupView): Slice {
  const shown: MarkupView = hidesInsertions(view) ? 'original' : 'none'
  const content = visibleFragment(slice.content, shown)
  return cleanSlice(content === slice.content ? slice : new Slice(content, slice.openStart, slice.openEnd))
}
