import { useEditorState } from '@tiptap/react'
import { useEffect, useId, useState, useSyncExternalStore } from 'react'
import { getEditor, subscribeEditor } from './controller'
import { fontFamilyCss, listSystemFonts, primaryFontFamily } from './fonts'

export interface FontFamilyPickerProps {
  /** Font list source (must be a stable reference); defaults to the Tauri OS font enumeration. */
  loadFonts?: () => Promise<string[]>
}

const SYSTEM_DEFAULT = ''

/**
 * Minimal accessible font selector. Applies the chosen installed OS font to the
 * selection (or the stored marks at the caret) via TextStyle + FontFamily;
 * "System default" removes it. Falls back to only "System default" when the
 * OS font list is unavailable.
 */
export function FontFamilyPicker({ loadFonts = listSystemFonts }: FontFamilyPickerProps) {
  const id = useId()
  const [fonts, setFonts] = useState<string[]>([])
  const editor = useSyncExternalStore(subscribeEditor, getEditor, () => null)

  useEffect(() => {
    let cancelled = false
    loadFonts()
      .then((list) => {
        if (!cancelled) setFonts(list)
      })
      .catch(() => {
        if (!cancelled) setFonts([])
      })
    return () => {
      cancelled = true
    }
  }, [loadFonts])

  const current =
    useEditorState({
      editor,
      selector: ({ editor: ed }) =>
        ed ? primaryFontFamily(ed.getAttributes('textStyle').fontFamily as string | undefined) : SYSTEM_DEFAULT,
    }) ?? SYSTEM_DEFAULT

  const options = current && !fonts.includes(current) ? [current, ...fonts] : fonts

  const onChange = (value: string) => {
    if (!editor) return
    const chain = editor.chain().focus()
    if (value === SYSTEM_DEFAULT) chain.unsetFontFamily().run()
    else chain.setFontFamily(fontFamilyCss(value)).run()
  }

  return (
    <span className="inline-flex items-center gap-2">
      <label htmlFor={id} className="text-sm">
        Font
      </label>
      <select
        id={id}
        title="Font family for the selected text"
        className="min-h-8 min-w-40 rounded border border-current/30 bg-transparent px-2 text-sm"
        value={current}
        disabled={!editor}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value={SYSTEM_DEFAULT}>System default</option>
        {options.map((f) => (
          <option key={f} value={f}>
            {f}
          </option>
        ))}
      </select>
    </span>
  )
}
