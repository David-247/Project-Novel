import { Extension, Mark } from '@tiptap/core'
import {
  DELETION_MARK,
  FORMAT_CHANGE_MARK,
  INSERTION_MARK,
  TRACKED_DELETE_ATTR,
  TRACKED_INSERT_ATTR,
  TRACKED_STYLE_ATTR,
} from '@/shared/track-changes'

/**
 * Track changes schema (docs/track-changes.md). Additive: Phase 1 and 2 manuscripts never carry
 * these marks or attributes and load unchanged; the attributes default to null and are left out of
 * manuscript.json while null (the editor controller strips them like other optional block attrs).
 *
 * Every mark sets `excludes: ''`: insertion, deletion, formatChange and the comments ticket's
 * comment mark may all overlap (an insertion by one author deleted by another carries both).
 */

/** Block node types that carry the tracking attributes. */
export const TRACKED_BLOCK_TYPES = ['paragraph', 'heading', 'pageBreak', 'sceneBreak'] as const

/** Only `#rgb` / `#rrggbb` author colours reach the style attribute. */
export function safeColor(v: unknown): string | null {
  return typeof v === 'string' && /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(v) ? v : null
}

const changeAttrs = (withColor: boolean) => ({
  id: { default: null, rendered: false },
  author: { default: '', rendered: false },
  ...(withColor ? { authorColor: { default: null, rendered: false } } : {}),
  date: { default: '', rendered: false },
})

function dataAttrs(kind: string, attrs: Record<string, unknown>, extraClass = ''): Record<string, string> {
  const out: Record<string, string> = {
    class: `nv-${kind}${extraClass}`,
    [`data-tc-${kind}`]: String(attrs.id ?? ''),
    'data-tc-author': String(attrs.author ?? ''),
    'data-tc-date': String(attrs.date ?? ''),
  }
  const color = safeColor(attrs.authorColor)
  if (color) out.style = `--nv-tc-color: ${color}`
  return out
}

const parseChange = (kind: string) => (el: HTMLElement) => ({
  id: el.getAttribute(`data-tc-${kind}`) || null,
  author: el.getAttribute('data-tc-author') ?? '',
  date: el.getAttribute('data-tc-date') ?? '',
})

/** Inserted text. Typing next to it does not extend it (inclusive: false); the recorder merges own runs. */
export const InsertionMark = Mark.create({
  name: INSERTION_MARK,
  inclusive: false,
  excludes: '',
  keepOnSplit: false,
  addAttributes: () => changeAttrs(true),
  parseHTML: () => [{ tag: 'span[data-tc-ins]', getAttrs: (el) => parseChange('ins')(el as HTMLElement) }],
  renderHTML: ({ mark }) => ['span', dataAttrs('ins', mark.attrs), 0],
})

/** Deleted text: stays in the document until the deletion is accepted. */
export const DeletionMark = Mark.create({
  name: DELETION_MARK,
  inclusive: false,
  excludes: '',
  keepOnSplit: false,
  addAttributes: () => changeAttrs(true),
  parseHTML: () => [{ tag: 'span[data-tc-del]', getAttrs: (el) => parseChange('del')(el as HTMLElement) }],
  renderHTML: ({ mark }) => ['span', dataAttrs('del', mark.attrs), 0],
})

/** Tracked formatting: `before` is the earlier set of formatting marks (JSON), restored on reject. */
export const FormatChangeMark = Mark.create({
  name: FORMAT_CHANGE_MARK,
  inclusive: false,
  excludes: '',
  keepOnSplit: false,
  addAttributes: () => ({ ...changeAttrs(false), before: { default: [], rendered: false } }),
  parseHTML: () => [{ tag: 'span[data-tc-fmt]', getAttrs: (el) => parseChange('fmt')(el as HTMLElement) }],
  renderHTML: ({ mark }) => ['span', dataAttrs('fmt', mark.attrs), 0],
})

const blockAttr = (dataName: string) => ({
  default: null,
  // Never split onto the new half of a block (the recorder decides what the new block is).
  keepOnSplit: false,
  parseHTML: () => null,
  renderHTML: (attrs: Record<string, unknown>) => {
    const v = attrs[dataName] as { author?: string } | null
    return v ? { [`data-tc-${dataName === TRACKED_STYLE_ATTR ? 'style' : dataName === TRACKED_INSERT_ATTR ? 'block-ins' : 'block-del'}`]: v.author ?? '' } : {}
  },
})

/**
 * Block-level tracking attributes:
 * - `trackedInsert {id, author, authorColor?, date}`: the boundary before this block was inserted
 *   (a paragraph split, a pasted or new paragraph, an inserted break). Reject joins the block to the
 *   one before it (or removes it when empty, or when it is a break).
 * - `trackedDelete {…}`: the boundary before this block was deleted (a paragraph join, a deleted
 *   paragraph or break). Accept joins (or removes) it.
 * - `trackedStyleChange {id, author, date, beforeStyleId, beforeType, beforeAttrs}`: the paragraph's
 *   style or formatting was changed; reject restores the earlier type and attributes.
 */
export const TrackedBlockAttributes = Extension.create({
  name: 'trackedBlockAttributes',
  addGlobalAttributes() {
    return [
      {
        types: [...TRACKED_BLOCK_TYPES],
        attributes: {
          [TRACKED_INSERT_ATTR]: blockAttr(TRACKED_INSERT_ATTR),
          [TRACKED_DELETE_ATTR]: blockAttr(TRACKED_DELETE_ATTR),
          [TRACKED_STYLE_ATTR]: blockAttr(TRACKED_STYLE_ATTR),
        },
      },
    ]
  },
})
