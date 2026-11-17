import { expect, test, type Page } from '@playwright/test'
import { editor, launch, lineEnd, lineStart, openRecent, reveal, ribbonTab, saveStatus, seedProject, waitForLayout, writeFile } from './helpers'

/**
 * Phase 3 acceptance, accessibility: WCAG 2.1 AA contrast measured on the rendered UI (computed colours
 * in the real engine), on the four paper surfaces in OS light and dark:
 *  - change marks: inserted, deleted and reformatted text on the paper (4.5:1), and their lines
 *    (underline, strike-through, dotted rule) against the paper (3:1, non-text);
 *  - comment highlights (a thread at rest and the active one): page text on the fill (4.5:1); the cards'
 *    text and buttons on the card (4.5:1);
 *  - re-write differences: page text on the removed / added tints (4.5:1), their lines on the tint
 *    (3:1); the version tabs, labels and Keep buttons;
 *  - the ribbon (tabs, and every tab's controls: text 4.5:1, icon-only by the SVG's stroke / fill 3:1)
 *    and the status bar.
 * Every probe must match (a minimum count each); OS reduced motion is on, and each reading is taken
 * once two readings a frame apart agree (no colour transition running).
 * Disabled controls are exempt (WCAG 1.4.3). The token-level checks stay in the unit tests
 * (track-changes/contrast.test.ts, comments/model.test.ts, rewrite/rewrite.test.tsx).
 */

const SURFACES = ['auto', 'book', 'white', 'dark'] as const
const SCHEMES = ['light', 'dark'] as const
const ctl = (page: Page, id: string) => page.locator(`[data-control-id="${id}"]`)

interface Sample {
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
type Probe = { what: string; sel: string; bgSel?: string; kind?: 'text' | 'line' | 'border' | 'auto'; all?: boolean; min?: number }

/**
 * Contrast of each probe in the page: the foreground on the composited background. The background is
 * every layer up to the first opaque one (colours, and the colour stops of gradient images: the
 * darkest and lightest stop each count, the worst result is kept). An image that is not a gradient, or
 * opacity below 1 that cannot be folded into the foreground's alpha, fails with a message (`errors`).
 */
async function measure(page: Page, probes: Probe[]): Promise<{ samples: Sample[]; missing: string[]; errors: string[] }> {
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

const RIBBON_TABS = ['home', 'insert', 'layout', 'review', 'view'] as const

const PAGE_PROBES: Probe[] = [
  { what: 'inserted text', sel: '.novel-editor-content .nv-ins' },
  { what: 'inserted text', sel: '.novel-editor-content .nv-ins', kind: 'line' },
  { what: 'deleted text', sel: '.novel-editor-content .nv-del' },
  { what: 'deleted text', sel: '.novel-editor-content .nv-del', kind: 'line' },
  { what: 'reformatted text', sel: '.novel-editor-content .nv-fmt' },
  { what: 'reformatted text', sel: '.novel-editor-content .nv-fmt', kind: 'border' },
  { what: 'comment highlight', sel: '.novel-editor-content .nv-comment[data-comment-id="c1"]' },
  { what: 'active comment highlight', sel: '.novel-editor-content .nv-comment[data-comment-id="c2"]' },
  { what: 'comment card text', sel: '[data-testid="comments-panel"] [data-testid="comment-text"]', bgSel: 'article', all: true, min: 2 },
  { what: 'comment card', sel: '[data-testid="comments-panel"] article[data-thread-id] :is(header, time, span)', bgSel: 'article', all: true, min: 2 },
  { what: 'comment card control', sel: '[data-testid="comments-panel"] article [data-control-id]', bgSel: 'article', kind: 'auto', all: true, min: 4 },
  { what: 'status bar', sel: 'footer[aria-label="Status bar"] [data-control-id], footer[aria-label="Status bar"] [role="status"], [data-testid="changes-indicator"]', kind: 'auto', all: true, min: 4 },
  { what: 'ribbon tab', sel: '[data-control-id^="ribbon.tab."]', all: true, min: 5 },
]

/** The controls of the ribbon tab shown (sampled on each of the five tabs). */
const ribbonProbe = (tab: string): Probe => ({ what: `ribbon ${tab}`, sel: `[data-ribbon-panel="${tab}"] [data-control-id]`, kind: 'auto', all: true, min: 3 })

const REWRITE_PROBES: Probe[] = [
  { what: 're-write removed words', sel: '[data-testid="rewrite-view"] .nv-rw-del' },
  { what: 're-write removed words', sel: '[data-testid="rewrite-view"] .nv-rw-del', kind: 'line' },
  { what: 're-write added words', sel: '[data-testid="rewrite-view"] .nv-rw-ins' },
  { what: 're-write added words', sel: '[data-testid="rewrite-view"] .nv-rw-ins', kind: 'line' },
  { what: 're-write page text', sel: '[data-testid="rewrite-view"] .nv-rw-text p', all: true, min: 2 },
  { what: 're-write label', sel: '[data-testid="rewrite-view"] .nv-rw-label', all: true, min: 2 },
  { what: 're-write control', sel: '[data-testid="rewrite-view"] [data-control-id]', kind: 'auto', all: true, min: 4 },
]

/** Measure until two readings a frame apart agree (no colour transition still running), then return it. */
async function settled(page: Page, probes: Probe[]) {
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

const text = (t: string, marks?: unknown[]) => ({ type: 'text', text: t, ...(marks ? { marks } : {}) })
const stamp = (id: string) => ({ id, author: 'Ann', date: '2026-11-01T10:00:00.000Z', authorColor: null })
const p = (...content: unknown[]) => ({ type: 'paragraph', content })
const thread = (id: string, body: string) => ({
  id,
  createdAt: '2026-11-01T10:00:00.000Z',
  author: 'Test Writer',
  resolved: false,
  messages: [{ id: `${id}-m`, author: 'Test Writer', date: '2026-11-01T10:00:00.000Z', text: body }],
})

test('WCAG AA contrast of the revision tools: four paper surfaces x OS light and dark', async ({ page }) => {
  test.setTimeout(180_000)
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await launch(page)
  const doc = {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 1 }, content: [text('Chapter One')] },
      p(text('The river ran '), text('quietly', [{ type: 'insertion', attrs: stamp('i1') }]), text(' '), text('and slowly', [{ type: 'deletion', attrs: stamp('d1') }]), text(' past the mill. The lantern burned.')),
      p(text('Morning', [{ type: 'comment', attrs: { id: 'c1' } }]), text(' came over the meadow, and the '), text('stranger', [{ type: 'comment', attrs: { id: 'c2' } }]), text(' walked on.')),
      p(text('She closed the window.')),
      p(text('Nobody spoke.')),
    ],
  }
  await seedProject(page, '/projects/Contrast3', 'Contrast3', doc)
  await writeFile(page, '/projects/Contrast3/comments.json', JSON.stringify({ version: 1, threads: [thread('c1', 'At rest.'), thread('c2', 'The active one.')] }))
  await openRecent(page, '/projects/Contrast3')
  await expect(saveStatus(page)).toHaveText('Contrast3: All changes saved')
  await waitForLayout(page)

  // A formatting change: recording on, Bold on "lantern".
  await editor(page).click()
  await page.evaluate(() => window.__nvE2E.setTracking(true))
  await page.evaluate(() => {
    const e = window.__nvE2E
    const at = e.blockPos(1) + 1 + 'The river ran quietly and slowly past the mill. The '.length
    e.selectText(at, at + 'lantern'.length)
  })
  await page.keyboard.press('ControlOrMeta+b')
  await expect(editor(page).locator('.nv-fmt')).toHaveText('lantern')
  await page.evaluate(() => window.__nvE2E.setTracking(false))

  // A re-write of paragraph 3 with added and removed words (then closed: it stays open as a draft).
  await page.evaluate(() => {
    const e = window.__nvE2E
    e.selectText(e.blockPos(3) + 2, e.blockPos(3) + 2)
  })
  await page.keyboard.press('ControlOrMeta+Alt+w')
  const view = page.getByTestId('rewrite-view')
  await expect(view).toBeVisible()
  // Into the revision (a click: the focus hand-over after opening is not what this test is about).
  const revision = page.getByRole('textbox', { name: 'Revised passage' })
  await revision.locator('p').first().click()
  await expect(revision).toBeFocused()
  await lineStart(page)
  await page.keyboard.type('Quietly, ')
  // Remove the paragraph's last words (the end of its last line: no word-jump keys, which differ by OS).
  await lineEnd(page)
  for (let k = 0; k < 12; k++) await page.keyboard.press('Backspace')
  await expect(view.locator('.nv-rw-ins').first()).toBeVisible({ timeout: 10_000 })
  await expect(view.locator('.nv-rw-del').first()).toBeVisible({ timeout: 10_000 })
  await ctl(page, 'rewrite.closeButton').click()
  await expect(view).toHaveCount(0)

  const failures: string[] = []
  let checked = 0
  let lowest = { ratio: Infinity, label: '' }
  const take = (where: string, got: Awaited<ReturnType<typeof measure>>, must: string[]) => {
    for (const m of got.missing) failures.push(`${where} ${m}`)
    for (const e of got.errors) failures.push(`${where} ${e}`)
    for (const w of must) if (!got.samples.some((x) => x.probe === w)) failures.push(`${where}: nothing sampled for ${w}`)
    for (const x of got.samples) {
      checked++
      if (x.ratio / x.min < lowest.ratio) lowest = { ratio: x.ratio / x.min, label: `${where} ${x.what}: ${x.ratio}:1 (min ${x.min}; fg ${x.fg} on ${x.bg})` }
      if (x.ratio < x.min) failures.push(`${where} ${x.what}: ${x.ratio}:1 < ${x.min}:1 (fg ${x.fg} on ${x.bg})`)
    }
  }
  for (const scheme of SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
    await expect(page.locator('html')).toHaveAttribute('data-theme', scheme)
    for (const surface of SURFACES) {
      const where = `${scheme}/${surface}`
      await (await reveal(page, `book.surface.${surface}`)).click()
      const resolved = surface === 'auto' ? (scheme === 'light' ? 'white' : 'dark') : surface
      await expect(page.locator('html')).toHaveAttribute('data-surface', resolved)
      // The second thread active (its card clicked), the first at rest.
      await page.locator('[data-testid="comments-panel"] article[data-thread-id="c2"] [data-testid="comment-text"]').click()
      await expect.poll(async () => (await page.evaluate(() => window.__nvE2E.comments())).activeId).toBe('c2')
      take(where, await settled(page, PAGE_PROBES), [
        'inserted text',
        'deleted text',
        'reformatted text',
        'comment highlight',
        'active comment highlight',
        'comment card text',
        'comment card',
        'comment card control',
        'ribbon tab',
        'status bar',
      ])
      // Every ribbon tab's controls.
      for (const tab of RIBBON_TABS) {
        await ribbonTab(page, tab)
        take(`${where} ribbon`, await settled(page, [ribbonProbe(tab)]), [`ribbon ${tab}`])
      }

      // The re-write view, opened again on its draft.
      await editor(page).focus()
      await page.evaluate(() => window.__nvE2E.runCommand('rewrite.next'))
      await expect(view).toBeVisible()
      take(`${where} re-write`, await settled(page, REWRITE_PROBES), ['re-write removed words', 're-write added words', 're-write page text', 're-write label', 're-write control'])
      await ctl(page, 'rewrite.closeButton').click()
      await expect(view).toHaveCount(0)
    }
  }
  console.info(`[phase3 contrast] ${checked} samples checked; lowest (ratio / minimum) ${lowest.ratio.toFixed(2)}: ${lowest.label}`)
  expect(failures).toEqual([])
})
