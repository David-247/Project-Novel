import type { ToolbarControlMeta } from '../toolbar/controls'

/**
 * Controls inside the Modify style and Manage styles dialogs. (The toolbar's Styles group lives in
 * TOOLBAR_CONTROLS.) The tooltips registry derives titles and shortcuts from here.
 */
export const STYLE_DIALOG_CONTROLS = {
  name: { id: 'styles.field.name', label: 'Style name' },
  kind: { id: 'styles.field.kind', label: 'Style type' },
  basedOn: { id: 'styles.field.basedOn', label: 'Based on' },
  nextStyle: { id: 'styles.field.nextStyle', label: 'Next paragraph' },
  fontFamily: { id: 'styles.field.fontFamily', label: 'Font' },
  fontSize: { id: 'styles.field.fontSize', label: 'Size (pt)' },
  fontWeight: { id: 'styles.field.fontWeight', label: 'Weight' },
  italic: { id: 'styles.field.italic', label: 'Slant' },
  textTransform: { id: 'styles.field.textTransform', label: 'Letter case' },
  letterSpacing: { id: 'styles.field.letterSpacing', label: 'Letter spacing (em)' },
  align: { id: 'styles.field.align', label: 'Alignment' },
  lineHeight: { id: 'styles.field.lineHeight', label: 'Line spacing' },
  spaceBefore: { id: 'styles.field.spaceBefore', label: 'Space before (pt)' },
  spaceAfter: { id: 'styles.field.spaceAfter', label: 'Space after (pt)' },
  firstLineIndent: { id: 'styles.field.firstLineIndent', label: 'First-line indent (em)' },
  indentLeft: { id: 'styles.field.indentLeft', label: 'Left indent (em)' },
  indentRight: { id: 'styles.field.indentRight', label: 'Right indent (em)' },
  breakBefore: { id: 'styles.field.breakBefore', label: 'Starts on' },
  modifyReset: { id: 'styles.modify.reset', label: 'Reset to default' },
  modifyCancel: { id: 'styles.modify.cancel', label: 'Cancel' },
  modifySave: { id: 'styles.modify.save', label: 'Save style' },
  manageItem: { id: 'styles.manage.item', label: 'Style' },
  manageNew: { id: 'styles.manage.new', label: 'New style' },
  manageDuplicate: { id: 'styles.manage.duplicate', label: 'Duplicate' },
  manageRename: { id: 'styles.manage.rename', label: 'Rename' },
  manageRenameField: { id: 'styles.manage.renameField', label: 'New name' },
  manageRenameSave: { id: 'styles.manage.renameSave', label: 'Save name' },
  manageRenameCancel: { id: 'styles.manage.renameCancel', label: 'Cancel rename' },
  manageModify: { id: 'styles.manage.modify', label: 'Modify…' },
  manageDelete: { id: 'styles.manage.delete', label: 'Delete' },
  manageDeleteConfirm: { id: 'styles.manage.deleteConfirm', label: 'Delete style' },
  manageDeleteCancel: { id: 'styles.manage.deleteCancel', label: 'Keep style' },
} as const satisfies Record<string, ToolbarControlMeta>

export type StyleDialogControlKey = keyof typeof STYLE_DIALOG_CONTROLS
