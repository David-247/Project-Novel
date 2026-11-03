import { EditorContent, useEditor } from '@tiptap/react'
import { useEffect, useState } from 'react'
import { attachEditor } from './controller'
import { createEditorExtensions } from './extensions'
import { SYSTEM_FONT_STACK } from './fonts'
import './editor.css'

/**
 * Continuous-scroll writing surface. Scrolling is provided by the host
 * (AppShell's editor slot scrolls); this renders a centered text column.
 * React does not re-render on transactions (typing latency budget).
 */
export function NovelEditor() {
  const [extensions] = useState(createEditorExtensions)
  const editor = useEditor({
    extensions,
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    // Tiptap's core "delete" extension only emits `delete` events (unused here), but computes
    // changed ranges in O(steps^2) after every transaction: ~5 s of main-thread time after a
    // 10,000-match Replace All on a 100k-word manuscript. Off.
    enableCoreExtensions: { delete: false },
    editorProps: {
      attributes: {
        class: 'novel-editor-content',
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': 'Manuscript',
        spellcheck: 'true',
      },
    },
  })

  useEffect(() => (editor ? attachEditor(editor) : undefined), [editor])

  return (
    <div
      className="novel-writing-surface mx-auto w-full max-w-[72ch] px-6 py-10"
      style={{ fontFamily: SYSTEM_FONT_STACK }}
      data-testid="writing-surface"
    >
      <EditorContent editor={editor} />
    </div>
  )
}
