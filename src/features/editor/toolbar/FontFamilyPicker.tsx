import { useEffect, useState } from 'react'
import type { Ref, SelectHTMLAttributes } from 'react'
import { Select } from '@/shared/ui'
import { fontFamilyCss, loadSystemFonts } from '../fonts'
import { TOOLBAR_CONTROLS } from './controls'
import { markChain } from './mark-chain'
import { useMountedEditor } from '../use-mounted-editor'
import { useToolbarState } from './use-toolbar-state'

export interface FontFamilyPickerProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'value' | 'onChange' | 'children'> {
  /** Font list source (must be a stable reference); defaults to the Tauri OS font enumeration. */
  loadFonts?: () => Promise<string[]>
  /** Width class of the control (default w-44). */
  wrapperClassName?: string
  ref?: Ref<HTMLSelectElement>
}

const SYSTEM_DEFAULT = ''

/** Installed OS font families, loaded once per `loadFonts` reference; `failed` if loading rejected. */
function useSystemFonts(loadFonts: () => Promise<string[]>): { fonts: string[]; failed: boolean } {
  const [state, setState] = useState<{ fonts: string[]; failed: boolean }>({ fonts: [], failed: false })
  useEffect(() => {
    let cancelled = false
    loadFonts()
      .then((fonts) => {
        if (!cancelled) setState({ fonts, failed: false })
      })
      .catch((e) => {
        console.warn('Listing installed fonts failed:', e)
        if (!cancelled) setState({ fonts: [], failed: true })
      })
    return () => {
      cancelled = true
    }
  }, [loadFonts])
  return state
}

/**
 * Font family control (toolbar `toolbar.fontFamily`). Applies the chosen installed OS font
 * to the selection (or the stored marks at the caret) via TextStyle + FontFamily;
 * "System default" removes it. Falls back to only "System default" when the OS font list
 * is unavailable; if listing them failed, that option says so. Focus handling: see `markChain`.
 */
export function FontFamilyPicker({ loadFonts = loadSystemFonts, disabled, wrapperClassName = 'w-44', ...rest }: FontFamilyPickerProps) {
  const { fonts, failed } = useSystemFonts(loadFonts)
  const editor = useMountedEditor()

  const current = useToolbarState(editor).fontFamily

  const names = current && !fonts.includes(current) ? [current, ...fonts] : fonts
  const defaultLabel = failed ? 'System default (installed fonts unavailable)' : 'System default'
  const options = [{ value: SYSTEM_DEFAULT, label: defaultLabel }, ...names.map((f) => ({ value: f, label: f }))]

  const onChange = (value: string) => {
    if (!editor) return
    if (value === SYSTEM_DEFAULT) markChain(editor).unsetFontFamily().run()
    else markChain(editor).setFontFamily(fontFamilyCss(value)).run()
  }

  return (
    <Select
      aria-label={TOOLBAR_CONTROLS.fontFamily.label}
      data-control-id={TOOLBAR_CONTROLS.fontFamily.id}
      wrapperClassName={wrapperClassName}
      options={options}
      value={current}
      disabled={disabled || !editor}
      onChange={(e) => onChange(e.target.value)}
      {...rest}
    />
  )
}
