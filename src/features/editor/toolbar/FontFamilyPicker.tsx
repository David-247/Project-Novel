import { useEffect, useState } from 'react'
import type { Ref, SelectHTMLAttributes } from 'react'
import { Select } from '@/shared/ui'
import { fontFamilyCss, listSystemFonts } from '../fonts'
import { TOOLBAR_CONTROLS } from './controls'
import { useMountedEditor } from './use-mounted-editor'
import { useToolbarState } from './use-toolbar-state'

export interface FontFamilyPickerProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'value' | 'onChange' | 'children'> {
  /** Font list source (must be a stable reference); defaults to the Tauri OS font enumeration. */
  loadFonts?: () => Promise<string[]>
  ref?: Ref<HTMLSelectElement>
}

const SYSTEM_DEFAULT = ''

/** Installed OS font families, loaded once per `loadFonts` reference ([] when unavailable). */
function useSystemFonts(loadFonts: () => Promise<string[]>): string[] {
  const [fonts, setFonts] = useState<string[]>([])
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
  return fonts
}

/**
 * Font family control (toolbar `toolbar.fontFamily`). Applies the chosen installed OS font
 * to the selection (or the stored marks at the caret) via TextStyle + FontFamily;
 * "System default" removes it. Falls back to only "System default" when the OS font list
 * is unavailable. Keeps focus on the control so keyboard users can keep browsing values
 * (Escape in the toolbar returns to the text).
 */
export function FontFamilyPicker({ loadFonts = listSystemFonts, disabled, ...rest }: FontFamilyPickerProps) {
  const fonts = useSystemFonts(loadFonts)
  const editor = useMountedEditor()

  const current = useToolbarState(editor).fontFamily

  const names = current && !fonts.includes(current) ? [current, ...fonts] : fonts
  const options = [{ value: SYSTEM_DEFAULT, label: 'System default' }, ...names.map((f) => ({ value: f, label: f }))]

  const onChange = (value: string) => {
    if (!editor) return
    if (value === SYSTEM_DEFAULT) editor.chain().unsetFontFamily().run()
    else editor.chain().setFontFamily(fontFamilyCss(value)).run()
  }

  return (
    <Select
      aria-label={TOOLBAR_CONTROLS.fontFamily.label}
      data-control-id={TOOLBAR_CONTROLS.fontFamily.id}
      wrapperClassName="w-44"
      options={options}
      value={current}
      disabled={disabled || !editor}
      onChange={(e) => onChange(e.target.value)}
      {...rest}
    />
  )
}
