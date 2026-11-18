import { expect, type Page } from '@playwright/test'

/**
 * WCAG 2.1 AA contrast measured on the rendered UI (computed colours in the real engine): the probes
 * and the measurer shared by the contrast audits (phase3-contrast.spec.ts, phase4-audits.spec.ts).
 */

export interface Sample {
  /** The probe's name (`Probe.what`): what the `must` lists name exactly. */
  probe: string
  what: string
  fg: string
  bg: string
  ratio: number
  min: number
}

/**
 * One kind of element to sample. `min`: how many must match (default 1): a probe that matches fewer
 * fails the test, so a renamed class can never turn into a silent pass. `all`: sample every match
 * (else the first). `kind`: text colour (4.5:1), a text-decoration line or a bottom border (3:1), or
 * 'auto' for controls: text when it has text, else its icon's SVG stroke / fill (3:1).
 */
export type Probe = { what: string; sel: string; bgSel?: string; kind?: 'text' | 'line' | 'border' | 'auto'; all?: boolean; min?: number }

/**
 * Contrast of each probe in the page: the foreground on the composited background. The background is
 * every layer up to the first opaque one (colours, and the colour stops of gradient images: the
 * darkest and lightest stop each count, the worst result is kept). An image that is not a gradient, or
 * opacity below 1 that cannot be folded into the foreground's alpha, fails with a message (`errors`).
 */
export async function measure(page: Page, probes: Probe[]): Promise<{ samples: Sample[]; missing: string[]; errors: string[] }> {
  return page.evaluate((list) => {
    // Any CSS colour: rgb()/rgba() read exactly; anything else (hsl, oklch, color(), a keyword) is
    // normalised by the browser, by painting it on a 1px canvas. Null: not a colour.
    const cv = document.createElement('canvas')
    cv.width = cv.height = 1
    const cx = cv.getContext('2d', { willReadFrequently: true })!
    const parse = (c: string): number[] | null => {
      if (c === 'transparent') return [0, 0, 0, 0]
      const m = c.match(/^rgba?\(([^)]+)\)$/)
      if (m) {
        const p = m[1].split(/[ ,/]+/).filter(Boolean).map((x) => (x.endsWith('%') ? parseFloat(x) / 100 : Number(x)))
        return [p[0], p[1], p[2], p[3] ?? 1]
      }
      for (const sentinel of ['#010203', '#040506']) {
        cx.fillStyle = sentinel
        cx.fillStyle = c
        // An invalid colour leaves fillStyle as it was (with both sentinels: not a colour).
        if (String(cx.fillStyle).toLowerCase() !== sentinel) {
          cx.clearRect(0, 0, 1, 1)
          cx.fillRect(0, 0, 1, 1)
          const d = cx.getImageData(0, 0, 1, 1).data
          return [d[0], d[1], d[2], d[3] / 255]
        }
      }
      return null
    }
    /** Top-level comma-separated arguments of the first function in `css` ("f(a, b(c, d))" -> ["a", "b(c, d)"]). */
    const args = (css: string) => {
      const out: string[] = []
      let depth = 0
      let cur = ''
      for (const ch of css.slice(css.indexOf('(') + 1, css.lastIndexOf(')'))) {
        if (ch === '(') depth++
        if (ch === ')') depth--
        if (ch === ',' && depth === 0) {
          out.push(cur.trim())
          cur = ''
        } else cur += ch
      }
      out.push(cur.trim())
      return out
    }
    const over = (top: number[], under: number[]) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3]))
    const lum = (rgb: number[]) => {
      const [r, g, b] = rgb.map((v) => {
        const s = v / 255
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    const ratio = (a: number[], b: number[]) => {
      const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
      return (x + 0.05) / (y + 0.05)
    }
    const name = (n: Element) => `<${n.tagName.toLowerCase()}${n.className && typeof n.className === 'string' ? '.' + n.className.trim().split(/\s+/).join('.') : ''}>`
    /**
     * Gradient colour stops, in any CSS colour syntax: the darkest and the lightest (by luminance over
     * `base`). A stop whose colour cannot be read throws (never a silent skip).
     */
    const COLOUR = /(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\((?:[^()]|\([^()]*\))*\)|#[0-9a-f]{3,8}\b|\b[a-z][a-z-]*\b/gi
    const NOT_COLOUR =
      /^(?:to|at|top|bottom|left|right|center|circle|ellipse|closest-side|closest-corner|farthest-side|farthest-corner|in|srgb|srgb-linear|display-p3|hsl|hwb|lab|lch|oklab|oklch|longer|shorter|increasing|decreasing|hue|from|deg|turn|rad|grad|px|em|rem)$/i
    const stopsOf = (image: string, base: number[]) => {
      const stops: number[][] = []
      // One layer per gradient (several comma-separated images).
      for (const layer of image.match(/(?:repeating-)?(?:linear|radial|conic)-gradient\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)/g) ?? []) {
        for (const arg of args(layer)) {
          const colours = (arg.match(COLOUR) ?? []).filter((t) => !NOT_COLOUR.test(t))
          // No colour: the direction / shape argument, or a bare position hint.
          for (const c of colours) {
            const rgba = parse(c)
            if (!rgba) throw new Error(`gradient stop "${c}" in ${image.slice(0, 80)}: not a readable colour`)
            stops.push(over(rgba, base))
          }
        }
      }
      if (!stops.length) throw new Error(`no colour stop read in ${image.slice(0, 80)}`)
      const sorted = [...stops].sort((x, y) => lum(x) - lum(y))
      return [sorted[0], sorted[sorted.length - 1]]
    }
    /** The candidate backgrounds behind `el`, and the opacity to fold into the foreground. */
    const backOf = (el: Element): { cands: number[][]; alpha: number } => {
      const layers: { color: number[]; image: string; node: Element }[] = []
      let alpha = 1
      for (let n: Element | null = el; n; n = n.parentElement) {
        const cs = getComputedStyle(n)
        const color = parse(cs.backgroundColor) ?? [0, 0, 0, 0]
        const image = cs.backgroundImage
        if (image && image !== 'none' && !/gradient\(/.test(image)) throw new Error(`background image ${image.slice(0, 60)} on ${name(n)}: cannot sample its colour`)
        const opacity = Number(cs.opacity)
        const opaque = color[3] >= 1
        if (opacity < 1) {
          // Folded into the foreground only when nothing between the element and here paints a background.
          if (layers.length || color[3] > 0 || (image && image !== 'none') || opaque) throw new Error(`opacity ${opacity} on ${name(n)} over a background layer: not measurable here`)
          alpha *= opacity
        }
        if (color[3] > 0 || (image && image !== 'none')) layers.push({ color, image, node: n })
        if (opaque) break
      }
      let cands = [[255, 255, 255]]
      for (const l of layers.reverse()) {
        cands = cands.map((c) => over(l.color, c))
        if (l.image && l.image !== 'none') cands = cands.flatMap((c) => [c, ...stopsOf(l.image, c)])
      }
      return { cands, alpha }
    }
    /** The shape's fill covers some area: some point of an 8x8 grid over its box is inside it. */
    const fills = (shape: Element) => {
      if (!(shape instanceof SVGGeometryElement) || shape instanceof SVGLineElement) return shape instanceof SVGTextElement
      const b = shape.getBBox()
      if (b.width <= 0 || b.height <= 0) return false
      for (let i = 0; i < 8; i++)
        for (let j = 0; j < 8; j++) if (shape.isPointInFill(new DOMPoint(b.x + ((i + 0.5) * b.width) / 8, b.y + ((j + 0.5) * b.height) / 8))) return true
      return false
    }
    const samples: { probe: string; what: string; fg: string; bg: string; ratio: number; min: number }[] = []
    const missing: string[] = []
    const errors: string[] = []
    for (const p of list) {
      const els = Array.from(document.querySelectorAll(p.sel)).filter((el) => {
        const h = el as HTMLElement
        if (h.closest('[disabled], [aria-disabled="true"], [data-disabled]')) return false
        const r = h.getBoundingClientRect()
        return r.width > 0 && r.height > 0 && getComputedStyle(h).visibility !== 'hidden'
      })
      if (els.length < (p.min ?? 1)) missing.push(`${p.what}: ${els.length} of at least ${p.min ?? 1} matched (${p.sel})`)
      for (const el of p.all ? els : els.slice(0, 1)) {
        const cs = getComputedStyle(el)
        let kind = p.kind ?? 'text'
        // Foreground paints, each [colour, opacity folded into it]. Text and lines have one; an icon has
        // every painted part of every shape (stroke and fill, with stroke-opacity / fill-opacity).
        let raws: [string, number][] = [[cs.color, 1]]
        let fgEl: Element = el
        if (kind === 'auto') {
          const svg = el.matches('svg') ? el : el.querySelector('svg')
          if ((el.textContent ?? '').trim() || !svg) kind = 'text'
          else {
            // The painted shapes carry the colour (an <svg> itself reports the initial fill, black).
            raws = []
            for (const shape of Array.from(svg.querySelectorAll('path, line, polyline, polygon, circle, ellipse, rect, text'))) {
              const ss = getComputedStyle(shape)
              if (ss.display === 'none' || ss.visibility === 'hidden') continue
              const o = Number(ss.opacity)
              if (ss.stroke && ss.stroke !== 'none' && parseFloat(ss.strokeWidth) > 0) raws.push([ss.stroke, o * Number(ss.strokeOpacity)])
              // A fill paints only where the shape has an inside: not for a line, nor for a path of
              // straight strokes only ("M3.5 8h9": the default black fill covers nothing).
              if (ss.fill && ss.fill !== 'none' && fills(shape)) raws.push([ss.fill, o * Number(ss.fillOpacity)])
            }
            if (!raws.length) raws = [[getComputedStyle(svg).color, 1]]
            fgEl = svg
            kind = 'line'
          }
        } else if (kind === 'line') raws = [[cs.textDecorationColor, 1]]
        else if (kind === 'border') raws = [[cs.borderBottomColor, 1]]
        const id = el.getAttribute('data-control-id')
        const what = `${p.what}${p.all && id ? ` ${id}` : ''}${kind === 'text' ? '' : ` (${p.kind === 'auto' ? 'icon' : kind})`}`
        let back: { cands: number[][]; alpha: number }
        try {
          back = backOf(p.bgSel ? (fgEl.closest(p.bgSel) ?? fgEl) : fgEl)
        } catch (e) {
          errors.push(`${what}: ${(e as Error).message}`)
          continue
        }
        const fgs: number[][] = []
        for (const [raw, opacity] of raws) {
          const fg = parse(raw)
          if (!fg) errors.push(`${what}: unreadable colour ${raw}`)
          else fgs.push([fg[0], fg[1], fg[2], fg[3] * opacity * back.alpha])
        }
        if (fgs.length < raws.length) continue
        let worst = { r: Infinity, f: [0, 0, 0], b: [0, 0, 0] }
        for (const fg of fgs)
          for (const bg of back.cands) {
            const f = over(fg, bg)
            const r = ratio(f, bg)
            if (r < worst.r) worst = { r, f, b: bg }
          }
        samples.push({ probe: p.what, what, fg: worst.f.map(Math.round).join(','), bg: worst.b.map(Math.round).join(','), ratio: +worst.r.toFixed(2), min: kind === 'text' ? 4.5 : 3 })
      }
    }
    return { samples, missing, errors }
  }, probes)
}

/** Measure until two readings a frame apart agree (no colour transition still running), then return it. */
export async function settled(page: Page, probes: Probe[]) {
  let last = ''
  let result: Awaited<ReturnType<typeof measure>> | null = null
  await expect
    .poll(async () => {
      result = await measure(page, probes)
      const now = JSON.stringify(result)
      const same = now === last
      last = now
      return same
    }, { message: 'computed colours settle', intervals: [50, 100, 200] })
    .toBe(true)
  return result!
}
