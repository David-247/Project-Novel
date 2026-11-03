import type { Editor } from '@tiptap/core'
import { primaryFontFamily } from '../fonts'
import { inListItem } from './block-format'
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
  canIndent: boolean
  canOutdent: boolean
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
  canIndent: false,
  canOutdent: false,
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/**
 * Toolbar state derived from the selection. Cost is O(selection) for marks (O(1) for a
 * caret: stored marks / `$from.marks()`) and O(depth) for block state read from the
 * selection's parent block; it never walks the document.
 */
export function readToolbarState(editor: Editor | null): ToolbarState {
  if (!editor || editor.isDestroyed) return IDLE_TOOLBAR_STATE
  const { state } = editor
  const block = state.selection.$from.parent
  const textStyle = editor.getAttributes('textStyle')
  const inList = inListItem(state)
  const indent = typeof block.attrs.indent === 'number' ? block.attrs.indent : 0
  const align = str(block.attrs.textAlign)
  return {
    ready: true,
    bold: editor.isActive('bold'),
    italic: editor.isActive('italic'),
    underline: editor.isActive('underline'),
    bulletList: editor.isActive('bulletList'),
    orderedList: editor.isActive('orderedList'),
    align: align === 'center' || align === 'right' || align === 'justify' ? align : 'left',
    fontFamily: primaryFontFamily(str(textStyle.fontFamily)),
    fontSize: str(textStyle.fontSize),
    lineHeight: str(block.attrs.lineHeight),
    paragraphSpacing: str(block.attrs.paragraphSpacing),
    canIndent: inList || indent < MAX_INDENT,
    canOutdent: inList || indent > 0,
  }
}
