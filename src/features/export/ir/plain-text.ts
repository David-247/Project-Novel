import type { InlineRun, ManuscriptBlock, ManuscriptIR, NoteRun } from './types'

export interface PlainTextOptions {
  /** Line printed for a scene break (default '#', the usual manuscript marker); '' for a blank line. */
  sceneBreak?: string
  /** Append the footnotes ("[1] text"), after the last chapter (default false). */
  footnotes?: boolean
}

/** Text of runs; footnote references print as "[n]" only when `refs` is given. */
export function runsText(runs: readonly (InlineRun | NoteRun)[], refs?: (footnote: number) => string): string {
  let out = ''
  for (const r of runs) {
    if (r.kind === 'text') out += r.text
    else if (r.kind === 'lineBreak') out += '\n'
    else if (refs) out += refs(r.footnote)
  }
  return out
}

/**
 * The manuscript as plain text, one paragraph per line: front matter, then per chapter its number,
 * title and blocks. Breaks print as `sceneBreak` (scene) or nothing (page, section); list items get
 * their marker. Footnote references are left out of the running text. For tests, the mock renderer
 * and checks such as word-count parity (the text an export contains).
 */
export function manuscriptPlainText(ir: ManuscriptIR, options: PlainTextOptions = {}): string {
  const scene = options.sceneBreak ?? '#'
  const lines: string[] = []
  const blocks = (list: readonly ManuscriptBlock[]) => {
    for (const b of list) {
      if (b.kind === 'sceneBreak') lines.push(scene)
      else if (b.kind === 'paragraph') lines.push((b.list?.marker ? `${b.list.marker} ` : '') + runsText(b.runs))
    }
  }
  blocks(ir.frontMatter)
  for (const c of ir.chapters) {
    if (c.numberText) lines.push(runsText(c.number))
    if (c.titleText) lines.push(runsText(c.title))
    blocks(c.blocks)
  }
  if (options.footnotes) for (const f of ir.footnotes) lines.push(`[${f.number}] ${runsText(f.runs)}`)
  return lines.join('\n')
}
