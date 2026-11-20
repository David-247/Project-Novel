import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'

/** Where and why the context menu opens. `x` / `y`: viewport point for the menu's corner. */
export interface ContextMenuRequest {
  pos: number
  x: number
  y: number
  /** Opened from the keyboard (Shift+F10, the Menu key): the first item takes the focus. */
  keyboard?: boolean
}

type Opener = (request: ContextMenuRequest) => boolean

let opener: Opener | null = null

/** Internal: the mounted <EditorContextMenu> opens itself through this. Returns unset. */
export function setContextMenuOpener(next: Opener): () => void {
  opener = next
  return () => {
    if (opener === next) opener = null
  }
}

/** Open the manuscript's context menu about `pos` at a viewport point. False when no menu is mounted. */
export function openEditorContextMenu(request: ContextMenuRequest): boolean {
  return opener?.(request) ?? false
}

/** Shift+F10 or the Menu key (Windows' and Word's keys for the context menu). */
export const isContextMenuKey = (e: KeyboardEvent): boolean =>
  e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey)

/** After a key opened the menu, the browser may still fire its own (keyboard) contextmenu event. */
const KEY_ECHO_MS = 1000

/**
 * The caret now. ProseMirror reads a native selection change (a click, an arrow key) a moment later,
 * so a key pressed right after it would see the old one: the DOM selection, when it is in the view,
 * is the caret.
 */
function caretPos(view: EditorView): number {
  const dom = view.dom.ownerDocument.getSelection()
  if (dom?.focusNode && view.dom.contains(dom.focusNode)) {
    try {
      return view.posAtDOM(dom.focusNode, dom.focusOffset)
    } catch {
      // Not a place in the document (a widget): the state's selection.
    }
  }
  return view.state.selection.head
}

/** Open at the caret: just below it. */
function openAtCaret(view: EditorView): boolean {
  const head = caretPos(view)
  let x: number
  let y: number
  try {
    const c = view.coordsAtPos(head)
    x = c.left
    y = c.bottom
  } catch {
    const r = view.dom.getBoundingClientRect()
    x = r.left
    y = r.top
  }
  return openEditorContextMenu({ pos: head, x, y, keyboard: true })
}

/**
 * The manuscript's side: right-click (a click outside the selection first moves the caret there, as
 * in Word), Shift+F10 and the Menu key. Without a mounted menu the webview's own menu shows.
 */
export const EditorContextMenuKeys = Extension.create({
  name: 'editorContextMenu',
  addProseMirrorPlugins() {
    let keyOpenedAt = -Infinity
    return [
      new Plugin({
        key: new PluginKey('editorContextMenu'),
        props: {
          handleKeyDown(view, event) {
            if (!isContextMenuKey(event)) return false
            if (!openAtCaret(view)) return false
            keyOpenedAt = performance.now()
            event.preventDefault()
            return true
          },
          handleDOMEvents: {
            contextmenu(view, event) {
              if (performance.now() - keyOpenedAt < KEY_ECHO_MS) {
                keyOpenedAt = -Infinity
                event.preventDefault()
                return true
              }
              const at = view.posAtCoords({ left: event.clientX, top: event.clientY })
              const { selection } = view.state
              let pos = at?.pos ?? selection.head
              // A keyboard-made contextmenu event (no pointer place) is about the caret.
              const fromKeyboard = event.clientX === 0 && event.clientY === 0
              if (fromKeyboard) pos = selection.head
              else if (at && (pos < selection.from || pos > selection.to)) {
                view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos))))
              }
              const opened = fromKeyboard ? openAtCaret(view) : openEditorContextMenu({ pos, x: event.clientX, y: event.clientY })
              if (!opened) return false
              event.preventDefault()
              return true
            },
          },
        },
      }),
    ]
  },
})
