import { contrastRatio } from '@/shared/theme'
import { isColor, isCommentId, type CommentThread } from './model'

/**
 * Anchor highlights. The mark renders `<span class="nv-comment" data-comment-id>`; its default soft
 * highlight is the paper token `--page-comment-bg` (comments.css, AA on all four papers). A thread
 * with an author colour gets that colour mixed into the paper, as strong as AA for the page text
 * allows on the current paper. Resolved threads lose the highlight unless Show Resolved is on; the
 * active (selected / hovered) thread gets `--page-comment-active-bg` and an underline. Two generated
 * style sheets (colours; active / hovered), each rebuilt only when its inputs change: nothing per keystroke.
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

/**
 * The two sheets: `colors` (author colours, resolved threads hidden), rebuilt only when the threads,
 * Show Resolved or the paper change, and the small `active` one (the selected / hovered thread), rebuilt
 * on hover: a hover never regenerates a rule listing every thread.
 */
export function buildHighlightSheets(input: HighlightInput): { colors: string; active: string } {
  return { colors: buildColorCss(input), active: buildActiveCss(input) }
}

/** `buildHighlightSheets`, joined (one sheet). */
export function buildHighlightCss(input: HighlightInput): string {
  const { colors, active } = buildHighlightSheets(input)
  return [colors, active].filter(Boolean).join('\n')
}

const isHidden = (t: CommentThread, showResolved: boolean) => t.resolved && !showResolved

export function buildColorCss({ threads, showResolved, pageBg, pageFg }: Omit<HighlightInput, 'activeId' | 'hoverId'>): string {
  const rules: string[] = []
  const byColor = new Map<string, string[]>()
  const hidden: string[] = []
  for (const t of threads) {
    if (!isCommentId(t.id)) continue
    if (isHidden(t, showResolved)) hidden.push(t.id)
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
  return rules.join('\n')
}

export function buildActiveCss({ threads, activeId, hoverId, showResolved }: Pick<HighlightInput, 'threads' | 'activeId' | 'hoverId' | 'showResolved'>): string {
  // A hidden (resolved) thread is not lit either.
  const lit = [...new Set([activeId, hoverId])].filter((id): id is string => {
    if (!isCommentId(id)) return false
    const t = threads.find((x) => x.id === id)
    return !t || !isHidden(t, showResolved)
  })
  if (!lit.length) return ''
  return `:root .nv-comment${sel(lit)}[data-comment-id]{background-color:var(--page-comment-active-bg);box-shadow:inset 0 -2px 0 var(--page-comment-ring)}`
}
