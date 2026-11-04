import { DOMSerializer, type Node as PMNode, type Schema } from '@tiptap/pm/model'
import { FOOTNOTE_TEXT_STYLE_ID, resolveFootnoteOptions, styleToInlineCSS, type ResolvedStyles } from '@/shared/book'
import type { PageGeometry } from '@/features/pagination'

/** CSS px per book point (the page surface's --nv-pt). */
export const PT = 96 / 72
/** Space between the body text and the first note, with and without the separator rule (pt). */
const TOP_WITH_RULE_PT = 9
const TOP_PLAIN_PT = 6
/** Most of the text block the footnotes of one page may take (the rest continue on the next page). */
export const MAX_AREA_SHARE = 0.6

/** Everything that decides how a note is set: one key, for measurement caches. */
export interface NoteStyle {
  key: string
  /** Inline style of the area and of the measurer (Footnote Text, with an exact line height). */
  css: Record<string, string>
  lineHeight: number
  /** Px above the first note (space, and the rule when `separator`). */
  top: number
  separator: boolean
  /** Text block width and height (px). */
  width: number
  height: number
}

export function noteStyle(styles: ResolvedStyles, geometry: PageGeometry, rawOptions: unknown, fallbackFont: string): NoteStyle {
  const s = styles.get(FOOTNOTE_TEXT_STYLE_ID)
  const options = resolveFootnoteOptions(rawOptions as Record<string, unknown>)
  const sizePt = s?.fontSize ?? 9
  const lineHeight = Math.round(sizePt * PT * (s?.lineHeight ?? 1.3) * 100) / 100
  const css: Record<string, string> = s ? styleToInlineCSS(s) : {}
  delete css.marginTop
  delete css.marginBottom
  css.fontSize = `${sizePt * PT}px`
  css.lineHeight = `${lineHeight}px`
  css.fontFamily ??= fallbackFont
  const top = Math.round((options.separator ? TOP_WITH_RULE_PT : TOP_PLAIN_PT) * PT * 100) / 100
  return {
    key: JSON.stringify([css, top, geometry.contentWidth]),
    css,
    lineHeight,
    top,
    separator: options.separator,
    width: geometry.contentWidth,
    height: geometry.contentHeight,
  }
}

const serializers = new WeakMap<Schema, DOMSerializer>()

/** Fill `el` with a note: its mark, a space, then its text with marks (the manuscript's rendering). */
export function fillNote(el: HTMLElement, node: PMNode, label: string): void {
  let ser = serializers.get(node.type.schema)
  if (!ser) {
    ser = DOMSerializer.fromSchema(node.type.schema)
    serializers.set(node.type.schema, ser)
  }
  const mark = document.createElement('span')
  mark.className = 'nv-fn-mark'
  mark.textContent = label
  el.replaceChildren(mark, document.createTextNode(' '), ser.serializeFragment(node.content))
}

interface Measured {
  key: string
  lines: number
}

const cache = new WeakMap<PMNode, Measured>()
let epoch = 0
let measurer: HTMLDivElement | null = null

/** Forget every measurement (a web font finished loading). */
export function clearNoteMeasurements(): void {
  epoch++
}

/** Changes when the measurements were cleared. */
export const noteMeasurementEpoch = () => epoch

/**
 * Line count of each note set in `style` (cached by note node, label and style). Unmeasured notes
 * are laid out together in one hidden, contained element: one layout for all of them.
 */
export function measureNotes(notes: readonly { node: PMNode; label: string }[], style: NoteStyle): number[] {
  const out = new Array<number>(notes.length)
  const todo: number[] = []
  notes.forEach((n, i) => {
    const m = cache.get(n.node)
    if (m && m.key === `${epoch}|${n.label}|${style.key}`) out[i] = m.lines
    else todo.push(i)
  })
  if (todo.length === 0) return out
  if (!measurer || !measurer.isConnected) {
    measurer = document.createElement('div')
    measurer.setAttribute('aria-hidden', 'true')
    measurer.className = 'nv-fn-measurer'
    document.body.appendChild(measurer)
  }
  const box = measurer
  box.style.cssText = 'position:absolute;left:-100000px;top:0;visibility:hidden;contain:layout style;white-space:pre-wrap;overflow-wrap:break-word;'
  box.style.width = `${style.width}px`
  for (const [k, v] of Object.entries(style.css)) (box.style as unknown as Record<string, string>)[k] = v
  const els = todo.map((i) => {
    const el = document.createElement('div')
    fillNote(el, notes[i].node, notes[i].label)
    return el
  })
  box.replaceChildren(...els)
  todo.forEach((i, k) => {
    const h = els[k].getBoundingClientRect().height
    const lines = Math.max(1, Math.round(h / style.lineHeight))
    out[i] = lines
    cache.set(notes[i].node, { key: `${epoch}|${notes[i].label}|${style.key}`, lines })
  })
  box.replaceChildren()
  return out
}
