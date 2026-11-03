import type { Editor } from '@tiptap/core'
import type { Mark } from '@tiptap/pm/model'
import { Selection } from '@tiptap/pm/state'
import type { EditorState } from '@tiptap/pm/state'
import { primaryFontFamily } from '../fonts'
import { inListItem } from './block-format'
import { effectiveStyleId, STYLED_BLOCK_TYPES } from '../styles/block-styles'
import { MAX_INDENT } from './presets'

export type Alignment = 'left' | 'center' | 'right' | 'justify'

export interface ToolbarState {
  ready: boolean
  bold: boolean
  italic: boolean
  underline: boolean
  bulletList: boolean
  orderedList: boolean
  align: Alignment
  /** Primary font family name at the selection, '' = system default. */
  fontFamily: string
  /** TextStyle font size at the selection, '' = default. */
  fontSize: string
  lineHeight: string
  paragraphSpacing: string
  firstLineIndent: string
  canIndent: boolean
  canOutdent: boolean
  /** Effective paragraph/chapter style of the block at the selection head, '' outside styled blocks. */
  styleId: string
}

export const IDLE_TOOLBAR_STATE: ToolbarState = {
  ready: false,
  bold: false,
  italic: false,
  underline: false,
  bulletList: false,
  orderedList: false,
  align: 'left',
  fontFamily: '',
  fontSize: '',
  lineHeight: '',
  paragraphSpacing: '',
  firstLineIndent: '',
  canIndent: false,
  canOutdent: false,
  styleId: '',
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/**
 * Marks that apply at the selection, in O(1):
 * - caret: `storedMarks ?? $from.marks()` (what the next typed character gets);
 * - range: marks present at BOTH ends (first char after `$from`, last char before `$to`).
 *   This deliberately does not scan the range, so a mark that is absent only in the middle
 *   of a long selection still shows as active (toggling then applies it everywhere).
 */
function selectionMarks(state: EditorState): readonly Mark[] {
  const { selection } = state
  const { $from, $to } = selection
  if (selection.empty) return state.storedMarks ?? $from.marks()
  // Range ends may sit between blocks (e.g. select-all): step to the nearest text position
  // inside the range. `findFrom` only looks at neighbouring blocks (O(depth) here).
  const $start = $from.parent.inlineContent ? $from : (Selection.findFrom($from, 1, true)?.$from ?? $from)
  const $end = $to.parent.inlineContent ? $to : (Selection.findFrom($to, -1, true)?.$to ?? $to)
  const start = $start.nodeAfter?.isText ? $start.nodeAfter.marks : $start.marks()
  const end = $end.nodeBefore?.isText ? $end.nodeBefore.marks : $end.marks()
  return start.filter((m) => m.isInSet(end))
}

/** Innermost list type around the selection head, O(depth). */
function innermostList(state: EditorState): string | null {
  const { $from } = state.selection
  for (let d = $from.depth; d > 0; d--) {
    const name = $from.node(d).type.name
    if (name === 'bulletList' || name === 'orderedList') return name
  }
  return null
}

/**
 * Toolbar state derived from the selection in O(depth) (plus `can().sinkListItem` inside
 * lists, also O(depth)); it never walks the document or the selected range.
 */
export function readToolbarState(editor: Editor | null): ToolbarState {
  if (!editor || editor.isDestroyed) return IDLE_TOOLBAR_STATE
  const { state } = editor
  const block = state.selection.$from.parent
  const marks = selectionMarks(state)
  const has = (name: string) => marks.some((m) => m.type.name === name)
  const textStyle = marks.find((m) => m.type.name === 'textStyle')?.attrs ?? {}
  const list = innermostList(state)
  const inList = inListItem(state)
  const indent = typeof block.attrs.indent === 'number' ? block.attrs.indent : 0
  const align = str(block.attrs.textAlign)
  return {
    ready: true,
    bold: has('bold'),
    italic: has('italic'),
    underline: has('underline'),
    bulletList: list === 'bulletList',
    orderedList: list === 'orderedList',
    align: align === 'center' || align === 'right' || align === 'justify' ? align : 'left',
    fontFamily: primaryFontFamily(str(textStyle.fontFamily)),
    fontSize: str(textStyle.fontSize),
    lineHeight: str(block.attrs.lineHeight),
    paragraphSpacing: str(block.attrs.paragraphSpacing),
    firstLineIndent: str(block.attrs.firstLineIndent),
    canIndent: inList ? editor.can().sinkListItem('listItem') : indent < MAX_INDENT,
    canOutdent: inList || indent > 0,
    styleId: (STYLED_BLOCK_TYPES as readonly string[]).includes(block.type.name) ? effectiveStyleId(block) : '',
  }
}
