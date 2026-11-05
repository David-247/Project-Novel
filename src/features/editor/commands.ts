import type { Editor } from '@tiptap/core'
import { STYLE_IDS } from '@/shared/book'
import { notifyCommandStateChanged, registerCommands, type Command } from '@/shared/commands'
import { useStore } from '@/shared/store'
import { detectPlatform, type Platform } from '@/shared/ui'
import { getEditor, subscribeDocLoad, subscribeEditor } from './controller'
import { fontFamilyCss, loadSystemFonts } from './fonts'
import { INSERT_ITEMS } from './breaks/controls'
import { FIND_CONTROLS } from './find/controls'
import { openFind } from './find/engine'
import { FIND_PANEL_ID } from './find/FindReplacePanel'
import { HISTORY_CONTROLS } from './history/controls'
import { modifyStyle, openModifyStyle, setManagingStyles } from './styles/dialog-state'
import { getResolvedStyles } from './styles/resolved'
import { TOOLBAR_CONTROLS, type ToolbarControlKey, type ToolbarControlMeta } from './toolbar/controls'
import { markChain } from './toolbar/mark-chain'
import { FONT_SIZES } from './toolbar/presets'
import { readToolbarState } from './toolbar/toolbar-state'

/**
 * The editor's commands for the Edit, Insert and Format menus (and their shortcuts). Ids reuse the
 * toolbar's control ids, so the tooltip copy and shortcut are the toolbar's. Every command acts
 * through the controller (`getEditor()`), the same way the toolbar buttons do.
 */

const ready = (): Editor | null => {
  const ed = getEditor()
  return ed && ed.isEditable ? ed : null
}
const can = () => ready() !== null
const state = () => readToolbarState(getEditor())

/** A text field other than the manuscript has focus (find field, a dialog's input). */
function focusedTextField(): HTMLInputElement | HTMLTextAreaElement | HTMLElement | null {
  const el = document.activeElement
  if (!(el instanceof HTMLElement)) return null
  const manuscript = getEditor()?.view.dom
  if (manuscript && (el === manuscript || manuscript.contains(el))) return null
  if (el instanceof HTMLTextAreaElement) return el
  if (el instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color'].includes(el.type)) return el
  return el.isContentEditable ? el : null
}

/** A nested ProseMirror editor (the footnote popover): its Undo is the book's history, as in its keymap. */
const isNestedEditor = (el: HTMLElement) => el.isContentEditable && !!el.closest('.ProseMirror')

function historyEnabled(cmd: 'undo' | 'redo'): boolean {
  const field = focusedTextField()
  if (field && !isNestedEditor(field)) return true
  return can() && getEditor()!.can()[cmd]()
}

/** Undo / Redo: the focused text field's own history, else the manuscript's (footnote notes included). */
function runHistory(cmd: 'undo' | 'redo'): void {
  const field = focusedTextField()
  if (field && !isNestedEditor(field)) document.execCommand(cmd)
  else if (field) getEditor()?.commands[cmd]() // focus stays in the note
  else ready()?.chain().focus()[cmd]().run()
}

/** Insert text from the system clipboard into the manuscript (Paste / Paste as Plain Text from a menu). */
async function pasteFromClipboard(plain: boolean): Promise<void> {
  const ed = ready()
  if (!ed) return
  try {
    if (!plain && navigator.clipboard.read) {
      for (const item of await navigator.clipboard.read()) {
        if (item.types.includes('text/html')) {
          ed.view.pasteHTML(await (await item.getType('text/html')).text())
          return
        }
      }
    }
    ed.view.pasteText(await navigator.clipboard.readText())
  } catch (e) {
    // The webview refused clipboard access to script; the keyboard shortcut still works.
    console.warn('Paste from the menu failed; use the keyboard shortcut instead.', e)
  }
}

/** One line per toolbar command (the toolbar's tooltip copy says the same; it lives in the tooltips slice). */
const DESCRIPTIONS: Partial<Record<ToolbarControlKey, string>> = {
  bold: 'Make the selected text bold, or turn bold off.',
  italic: 'Italicize the selected text, or turn italics off.',
  underline: 'Underline the selected text, or remove the underline.',
  bulletList: 'Turn the selected paragraphs into a bulleted list, or back into paragraphs.',
  orderedList: 'Turn the selected paragraphs into a numbered list, or back into paragraphs.',
  alignLeft: 'Line the paragraph up along the left edge.',
  alignCenter: 'Center each line of the paragraph.',
  alignRight: 'Line the paragraph up along the right edge.',
  alignJustify: 'Stretch lines so both edges of the paragraph are straight.',
  indentDecrease: 'Move the paragraph one step to the left.',
  indentIncrease: 'Move the paragraph one step to the right.',
}

const MENU_LABELS: Partial<Record<ToolbarControlKey, string>> = {
  bulletList: 'Bulleted List',
  orderedList: 'Numbered List',
  indentDecrease: 'Decrease Indent',
  indentIncrease: 'Increase Indent',
}

function toggle(key: ToolbarControlKey, order: number, run: (ed: Editor) => void, checked: () => boolean, menu: Command['menu']): Command {
  const meta: ToolbarControlMeta = TOOLBAR_CONTROLS[key]
  return {
    id: meta.id,
    label: MENU_LABELS[key] ?? meta.label,
    description: DESCRIPTIONS[key] ?? `${meta.label}.`,
    shortcut: typeof meta.shortcut === 'string' ? meta.shortcut : undefined,
    menu: menu ?? { id: 'format', group: 'marks', order },
    isEnabled: can,
    isChecked: () => can() && checked(),
    run: () => {
      const ed = ready()
      if (ed) run(ed)
    },
  }
}

const ALIGN: { key: ToolbarControlKey; value: 'left' | 'center' | 'right' | 'justify'; label: string }[] = [
  { key: 'alignLeft', value: 'left', label: 'Left' },
  { key: 'alignCenter', value: 'center', label: 'Center' },
  { key: 'alignRight', value: 'right', label: 'Right' },
  { key: 'alignJustify', value: 'justify', label: 'Justify' },
]

/** The fixed editor commands (style and font-size lists are added by registerEditorCommands). */
export function editorCommands(platform: Platform = detectPlatform()): Command[] {
  const edit = (group: string, order: number): Command['menu'] => ({ id: 'edit', group, order })
  const insert = INSERT_ITEMS.map((item, i): Command => {
    const labels: Record<string, string> = {
      'insert.newChapter': 'Chapter Break',
      'insert.pageBreak': 'Page Break',
      'insert.sceneBreak': 'Scene Break',
      'footnote.insert': 'Footnote',
    }
    const order: Record<string, number> = { 'insert.newChapter': 10, 'insert.pageBreak': 20, 'insert.sceneBreak': 30, 'footnote.insert': 10 }
    return {
      id: item.id,
      label: labels[item.id] ?? item.label,
      description: item.description,
      shortcut: typeof item.shortcut === 'string' ? item.shortcut : undefined,
      menu: { id: 'insert', group: item.id === 'footnote.insert' ? 'notes' : 'breaks', order: order[item.id] ?? 50 + i },
      isEnabled: can,
      run: () => {
        const ed = ready()
        if (ed) item.run(ed)
      },
    }
  })
  return [
    {
      id: HISTORY_CONTROLS.undo.id,
      label: 'Undo',
      description: 'Take back your last change.',
      shortcut: HISTORY_CONTROLS.undo.shortcut,
      menu: edit('history', 10),
      isEnabled: () => historyEnabled('undo'),
      run: () => runHistory('undo'),
    },
    {
      id: HISTORY_CONTROLS.redo.id,
      label: 'Redo',
      description: 'Put back the change you just undid.',
      shortcut: HISTORY_CONTROLS.redo.shortcut[0],
      menu: edit('history', 20),
      isEnabled: () => historyEnabled('redo'),
      run: () => runHistory('redo'),
    },
    {
      id: 'edit.cut',
      label: 'Cut',
      description: 'Remove the selected text and put it on the clipboard.',
      shortcut: 'Mod-x',
      nativeShortcut: true,
      menu: edit('clipboard', 10),
      run: () => document.execCommand('cut'),
    },
    {
      id: 'edit.copy',
      label: 'Copy',
      description: 'Put a copy of the selected text on the clipboard.',
      shortcut: 'Mod-c',
      nativeShortcut: true,
      menu: edit('clipboard', 20),
      run: () => document.execCommand('copy'),
    },
    {
      id: 'edit.paste',
      label: 'Paste',
      description: 'Insert the clipboard at the cursor.',
      shortcut: 'Mod-v',
      nativeShortcut: true,
      menu: edit('clipboard', 30),
      isEnabled: () => !!focusedTextField() || can(),
      run: () => {
        if (focusedTextField()) document.execCommand('paste')
        else void pasteFromClipboard(false)
      },
    },
    {
      id: 'edit.paste_plain',
      label: 'Paste as Plain Text',
      description: 'Insert the clipboard text at the cursor without its formatting.',
      shortcut: 'Mod-Shift-v',
      // Chromium/WebView2 paste plain text on Ctrl+Shift+V themselves; WebKit has no such key, so on
      // macOS the registry runs it (and the native menu item, when the webview declined the press).
      nativeShortcut: platform !== 'mac',
      menu: edit('clipboard', 40),
      isEnabled: can,
      run: () => void pasteFromClipboard(true),
    },
    {
      id: 'edit.select_all',
      label: 'Select All',
      description: 'Select the whole manuscript, or all of the text in the field you are in.',
      shortcut: 'Mod-a',
      nativeShortcut: true,
      menu: edit('clipboard', 50),
      run: () => {
        const field = focusedTextField()
        if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) field.select()
        else if (field) document.execCommand('selectAll')
        else getEditor()?.chain().focus().selectAll().run()
      },
    },
    {
      id: FIND_CONTROLS.open.id,
      label: 'Find…',
      description: 'Search the manuscript and replace words or phrases.',
      shortcut: FIND_CONTROLS.open.shortcut,
      menu: edit('find', 10),
      run: () => {
        // Already in the panel: re-focus the query, never re-prefill from the selection.
        const inPanel = document.activeElement?.closest(`#${FIND_PANEL_ID}`) != null
        openFind({ prefill: !inPanel })
      },
    },
    {
      id: 'edit.replace',
      label: 'Replace…',
      description: 'Open find and replace with the cursor in the Replace with field.',
      shortcut: 'Mod-Shift-h',
      menu: edit('find', 20),
      run: () => {
        openFind()
        // After the panel focused its query field (an effect on open).
        requestAnimationFrame(() =>
          setTimeout(() => document.querySelector<HTMLInputElement>(`input[data-control-id="${FIND_CONTROLS.replacement.id}"]`)?.focus(), 0),
        )
      },
    },
    ...insert,
    toggle('bold', 10, (ed) => ed.chain().focus().toggleBold().run(), () => state().bold, undefined),
    toggle('italic', 20, (ed) => ed.chain().focus().toggleItalic().run(), () => state().italic, undefined),
    toggle('underline', 30, (ed) => ed.chain().focus().toggleUnderline().run(), () => state().underline, undefined),
    ...ALIGN.map((a, i) => ({
      ...toggle(
        a.key,
        i,
        (ed) => (a.value === 'left' ? ed.chain().focus().unsetTextAlign().run() : ed.chain().focus().setTextAlign(a.value).run()),
        () => state().align === a.value,
        { id: 'format', group: 'paragraph', order: 20 + i, submenu: 'Alignment' },
      ),
      label: a.label,
    })),
    toggle('bulletList', 0, (ed) => ed.chain().focus().toggleBulletList().run(), () => state().bulletList, {
      id: 'format',
      group: 'paragraph',
      order: 30,
      submenu: 'Lists',
    }),
    toggle('orderedList', 0, (ed) => ed.chain().focus().toggleOrderedList().run(), () => state().orderedList, {
      id: 'format',
      group: 'paragraph',
      order: 31,
      submenu: 'Lists',
    }),
    {
      ...toggle('indentDecrease', 0, (ed) => ed.chain().focus().outdentBlock().run(), () => false, { id: 'format', group: 'paragraph', order: 32, submenu: 'Lists' }),
      isChecked: undefined,
      isEnabled: () => can() && state().canOutdent,
    },
    {
      ...toggle('indentIncrease', 0, (ed) => ed.chain().focus().indentBlock().run(), () => false, { id: 'format', group: 'paragraph', order: 33, submenu: 'Lists' }),
      isChecked: undefined,
      isEnabled: () => can() && state().canIndent,
    },
    {
      id: TOOLBAR_CONTROLS.clearFormatting.id,
      label: 'Clear Formatting',
      description: 'Remove formatting applied by hand, so the paragraph looks exactly like its style.',
      shortcut: TOOLBAR_CONTROLS.clearFormatting.shortcut,
      menu: { id: 'format', group: 'clear', order: 40 },
      isEnabled: can,
      run: () => void ready()?.chain().focus().clearDirectFormatting().run(),
    },
    {
      id: TOOLBAR_CONTROLS.styleEdit.id,
      label: 'Modify Style…',
      description: "Change how the current paragraph's style looks, everywhere in the manuscript.",
      menu: { id: 'format', group: 'styles', order: 50 },
      isEnabled: can,
      run: openModifyStyle,
    },
    {
      id: TOOLBAR_CONTROLS.styleManage.id,
      label: 'Manage Styles…',
      description: 'See every style in the book, and create, duplicate, rename or delete your own.',
      menu: { id: 'format', group: 'styles', order: 51 },
      isEnabled: can,
      run: () => {
        modifyStyle(null)
        setManagingStyles(true)
      },
    },
  ]
}

/** Format > Paragraph Style: one command per style of the book; Body and Chapter Title carry the shortcuts. */
export function styleCommands(): Command[] {
  const shortcuts: Record<string, string> = { [STYLE_IDS.body]: 'Mod-Alt-0', [STYLE_IDS.chapterTitle]: 'Mod-Alt-1' }
  return [...getResolvedStyles().values()].map((s, i) => ({
    id: `styles.apply.${s.id}`,
    label: s.name,
    description: `Give the paragraph the ${s.name} style.`,
    shortcut: shortcuts[s.id],
    menu: { id: 'format', group: 'paragraph', order: 10 + i / 1000, submenu: 'Paragraph Style' },
    isEnabled: can,
    isChecked: () => can() && state().styleId === s.id,
    run: () => void ready()?.chain().focus().setBlockStyle(s.id).run(),
  }))
}

/**
 * Format > Font: the font picker's choices (System Default, then the installed families from the same
 * list as the toolbar picker, `loadSystemFonts`). `failed`: the OS list could not be read.
 */
export function fontFamilyCommands(fonts: readonly string[], failed = false): Command[] {
  const current = () => state().fontFamily
  const def: Command = {
    id: 'format.fontFamily.system-default',
    label: failed ? 'System Default (installed fonts unavailable)' : 'System Default',
    description: 'Remove a typeface set by hand, so the text uses the default font.',
    menu: { id: 'format', group: 'font', order: 5, submenu: 'Font' },
    isEnabled: can,
    isChecked: () => can() && current() === '',
    run: () => {
      const ed = ready()
      if (ed) markChain(ed).unsetFontFamily().run()
    },
  }
  return [
    def,
    ...[...new Set(fonts)].map((f, i) => ({
      id: `format.fontFamily.${f}`,
      label: f,
      description: 'Set the selected text in this typeface.',
      menu: { id: 'format' as const, group: 'font', order: 5 + (i + 1) / 100_000, submenu: 'Font' },
      isEnabled: can,
      isChecked: () => can() && current() === f,
      run: () => {
        const ed = ready()
        if (ed) markChain(ed).setFontFamily(fontFamilyCss(f)).run()
      },
    })),
  ]
}

/** Format > Font Size: the toolbar's size presets. */
export function fontSizeCommands(): Command[] {
  return FONT_SIZES.map((p, i) => ({
    id: `format.fontSize.${p.value || 'default'}`,
    label: p.value ? p.label : 'Default Size',
    description: p.value ? `Set the selected text in ${p.label}.` : 'Remove a size set by hand from the selected text.',
    menu: { id: 'format', group: 'font', order: 6 + i / 1000, submenu: 'Font Size' },
    isEnabled: can,
    isChecked: () => can() && state().fontSize === p.value,
    run: () => {
      const ed = ready()
      if (!ed) return
      if (p.value) markChain(ed).setFontSize(p.value).run()
      else markChain(ed).unsetFontSize().run()
    },
  }))
}

/**
 * Register the editor's commands (Edit, Insert and Format menus). Enabled/checked state follows the
 * selection and the undo history; the style list follows book.styles. Returns unregister.
 */
export function registerEditorCommands(): () => void {
  const offFixed = registerCommands([...editorCommands(), ...fontSizeCommands()])
  let offStyles = registerCommands(styleCommands())
  // Font families: System Default now, the installed families once the OS list arrived.
  let disposed = false
  let offFonts = registerCommands(fontFamilyCommands([]))
  const showFonts = (fonts: string[], failed: boolean) => {
    if (disposed) return
    offFonts()
    offFonts = registerCommands(fontFamilyCommands(fonts, failed))
  }
  loadSystemFonts().then(
    (fonts) => showFonts(fonts, false),
    (e) => {
      console.warn('Listing installed fonts for the Font menu failed:', e)
      showFonts([], true)
    },
  )
  const offStore = useStore.subscribe((s, prev) => {
    if (s.book.styles !== prev.book.styles) {
      offStyles()
      offStyles = registerCommands(styleCommands())
    }
    if (s.project.opening !== prev.project.opening || s.editor.docVersion !== prev.editor.docVersion) notifyCommandStateChanged()
  })
  // Selection and history changes come as transactions of the mounted editor.
  let watched: Editor | null = null
  const watch = () => {
    watched?.off('transaction', notifyCommandStateChanged)
    watched = getEditor()
    watched?.on('transaction', notifyCommandStateChanged)
    notifyCommandStateChanged()
  }
  watch()
  const offEditor = subscribeEditor(watch)
  const offLoad = subscribeDocLoad(notifyCommandStateChanged)
  return () => {
    offLoad()
    offEditor()
    watched?.off('transaction', notifyCommandStateChanged)
    offStore()
    disposed = true
    offFonts()
    offStyles()
    offFixed()
  }
}
