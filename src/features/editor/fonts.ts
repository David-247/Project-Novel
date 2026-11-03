import { invoke } from '@tauri-apps/api/core'

/** Default writing font: the OS UI font. */
export const SYSTEM_FONT_STACK = 'system-ui, -apple-system, "Segoe UI", sans-serif'

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/**
 * Installed OS font family names (sorted, de-duplicated) from the Rust
 * `list_system_fonts` command. Outside Tauri (browser, vitest) or on any
 * failure it resolves to `[]`, meaning "system stack only".
 */
export async function listSystemFonts(): Promise<string[]> {
  if (!isTauri()) return []
  try {
    const fonts = await invoke<unknown>('list_system_fonts')
    return Array.isArray(fonts) ? fonts.filter((f): f is string => typeof f === 'string') : []
  } catch {
    return []
  }
}

/** CSS font-family value for an installed family, falling back to the system stack. */
export function fontFamilyCss(family: string): string {
  return `"${family.replace(/["\\]/g, '\\$&')}", ${SYSTEM_FONT_STACK}`
}

/** Inverse of `fontFamilyCss`: the primary family name of a CSS font-family value. */
export function primaryFontFamily(css: string | null | undefined): string {
  if (!css) return ''
  const quoted = /^\s*(["'])((?:\\.|(?!\1).)*)\1/.exec(css)
  if (quoted) return quoted[2].replace(/\\(.)/g, '$1')
  return css.split(',')[0].trim()
}
