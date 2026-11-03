/**
 * Stable identities for every toolbar control. Each rendered control carries
 * `data-control-id={id}`; the tooltips ticket maps ids to tooltip text. `shortcut` uses
 * Tiptap/ProseMirror notation ("Mod" = Cmd on macOS, Ctrl elsewhere).
 */
export interface ToolbarControlMeta {
  id: string
  /** Accessible name; also the tooltip title (the tooltips registry derives it from here). */
  label: string
  /** One or more shortcut specs; rendered per platform by the tooltip. */
  shortcut?: string | readonly string[]
}

export const TOOLBAR_CONTROLS = {
  fontFamily: { id: 'toolbar.fontFamily', label: 'Font family' },
  fontSize: { id: 'toolbar.fontSize', label: 'Font size' },
  bold: { id: 'toolbar.bold', label: 'Bold', shortcut: 'Mod-b' },
  italic: { id: 'toolbar.italic', label: 'Italic', shortcut: 'Mod-i' },
  underline: { id: 'toolbar.underline', label: 'Underline', shortcut: 'Mod-u' },
  bulletList: { id: 'toolbar.bulletList', label: 'Bulleted list', shortcut: 'Mod-Shift-8' },
  orderedList: { id: 'toolbar.orderedList', label: 'Numbered list', shortcut: 'Mod-Shift-7' },
  alignLeft: { id: 'toolbar.alignLeft', label: 'Align left', shortcut: 'Mod-Shift-l' },
  alignCenter: { id: 'toolbar.alignCenter', label: 'Align center', shortcut: 'Mod-Shift-e' },
  alignRight: { id: 'toolbar.alignRight', label: 'Align right', shortcut: 'Mod-Shift-r' },
  alignJustify: { id: 'toolbar.alignJustify', label: 'Justify', shortcut: 'Mod-Shift-j' },
  lineSpacing: { id: 'toolbar.lineSpacing', label: 'Line spacing' },
  paragraphSpacing: { id: 'toolbar.paragraphSpacing', label: 'Space after paragraph' },
  firstLineIndent: { id: 'toolbar.firstLineIndent', label: 'First-line indent' },
  indentDecrease: { id: 'toolbar.indentDecrease', label: 'Decrease indent', shortcut: 'Mod-[' },
  indentIncrease: { id: 'toolbar.indentIncrease', label: 'Increase indent', shortcut: 'Mod-]' },
} as const satisfies Record<string, ToolbarControlMeta>

export type ToolbarControlKey = keyof typeof TOOLBAR_CONTROLS
