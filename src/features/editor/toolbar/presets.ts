/**
 * Preset values offered by the formatting toolbar. Values are what is stored in the
 * document (TextStyle `fontSize`, block `lineHeight` / `paragraphSpacing`); `''` means
 * "unset" (inherit the editor default).
 */
export interface Preset {
  value: string
  label: string
}

export const FONT_SIZES: readonly Preset[] = [
  { value: '', label: 'Default size' },
  ...[10, 11, 12, 13, 14, 16, 18, 20, 24, 28, 32, 36].map((pt) => ({ value: `${pt}pt`, label: `${pt} pt` })),
]

export const LINE_SPACINGS: readonly Preset[] = [
  { value: '', label: 'Line: default' },
  { value: '1', label: 'Line: 1.0' },
  { value: '1.15', label: 'Line: 1.15' },
  { value: '1.5', label: 'Line: 1.5' },
  { value: '2', label: 'Line: 2.0' },
]

/** Space after a paragraph/heading (rendered as `margin-bottom`). */
export const PARAGRAPH_SPACINGS: readonly Preset[] = [
  { value: '', label: 'After: default' },
  { value: '0', label: 'After: none' },
  { value: '0.5em', label: 'After: small' },
  { value: '1em', label: 'After: medium' },
  { value: '1.5em', label: 'After: large' },
]

/** First-line indent (rendered as `text-indent`). 0.5 in is the manuscript-format standard. */
export const FIRST_LINE_INDENTS: readonly Preset[] = [
  { value: '', label: 'First line: default' },
  { value: '0', label: 'First line: none' },
  { value: '1em', label: 'First line: 1 em' },
  { value: '1.5em', label: 'First line: 1.5 em' },
  { value: '2em', label: 'First line: 2 em' },
  { value: '0.5in', label: 'First line: 0.5 in' },
]

/** Block indent: each level adds `INDENT_STEP_EM` em of left margin, up to `MAX_INDENT`. */
export const MAX_INDENT = 8
export const INDENT_STEP_EM = 2

/** Adds the current value to a preset list when it is not one of the presets (e.g. pasted content). */
export function withCurrent(presets: readonly Preset[], current: string): Preset[] {
  if (presets.some((p) => p.value === current)) return [...presets]
  return [...presets, { value: current, label: current }]
}
