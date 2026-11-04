import { contrastRatio } from '@/shared/theme'
import { isColor, isCommentId, type CommentThread } from './model'

/**
 * Anchor highlights. The mark renders `<span class="nv-comment" data-comment-id>`; its default soft
 * highlight is the paper token `--page-comment-bg` (comments.css, AA on all four papers). A thread
 * with an author colour gets that colour mixed into the paper, as strong as AA for the page text
 * allows on the current paper. Resolved threads lose the highlight unless Show Resolved is on; the
 * active (selected / hovered) thread gets `--page-comment-active-bg` and an underline. Everything is
 * one generated style sheet, rebuilt when threads or the selection change: nothing per keystroke.
 */

function hex(n: number): string {
  return Math.round(Math.min(255, Math.max(0, n)))
    .toString(16)
    .padStart(2, '0')
}

function rgb(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** `t` of `color` over `base` (sRGB). */
export function mixColor(color: string, base: string, t: number): string {
  const a = rgb(color)
  const b = rgb(base)
  return `#${a.map((c, i) => hex(c * t + b[i] * (1 - t))).join('')}`
}

/** Strongest mix (at most `max`) of `color` into the paper that keeps the text at 4.5:1. */
export function highlightFor(color: string, pageBg: string, pageFg: string, max = 0.36): string {
  for (let t = max; t > 0; t -= 0.02) {
    const bg = mixColor(color, pageBg, t)
    if (contrastRatio(pageFg, bg) >= 4.5) return bg
  }
  return pageBg
}

export interface HighlightInput {
  threads: readonly CommentThread[]
  activeId: string | null
  hoverId: string | null
  showResolved: boolean
  /** Current paper colours (`--page-bg`, `--page-fg`), when known. */
  pageBg: string | null
  pageFg: string | null
}

const sel = (ids: readonly string[]) =>
  ids.length === 1 ? `[data-comment-id="${ids[0]}"]` : `:is(${ids.map((id) => `[data-comment-id="${id}"]`).join(',')})`

export function buildHighlightCss({ threads, activeId, hoverId, showResolved, pageBg, pageFg }: HighlightInput): string {
  const rules: string[] = []
  const byColor = new Map<string, string[]>()
  const hidden: string[] = []
  for (const t of threads) {
    if (!isCommentId(t.id)) continue
    if (t.resolved && !showResolved) hidden.push(t.id)
    else if (isColor(t.authorColor)) {
      const c = t.authorColor.toLowerCase()
      byColor.set(c, [...(byColor.get(c) ?? []), t.id])
    }
  }
  if (isColor(pageBg) && isColor(pageFg)) {
    for (const [color, ids] of byColor) {
      rules.push(`.nv-comment${sel(ids)}{background-color:${highlightFor(color, pageBg, pageFg)}}`)
    }
  }
  if (hidden.length) rules.push(`:root .nv-comment${sel(hidden)}{background-color:transparent}`)
  const lit = [...new Set([activeId, hoverId])].filter((id): id is string => isCommentId(id))
  if (lit.length) {
    rules.push(
      `:root .nv-comment${sel(lit)}[data-comment-id]{background-color:var(--page-comment-active-bg);box-shadow:inset 0 -2px 0 var(--page-comment-ring)}`,
    )
  }
  return rules.join('\n')
}
