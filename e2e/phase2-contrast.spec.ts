import { expect, test, type Page } from '@playwright/test'
import { buildPaginationFixture } from './fixtures/pagination-manuscript'
import { isBookMode, launch, openRecent, saveStatus, seedProject, showPage, waitForLayout, reveal } from './helpers'

/**
 * Phase 2 acceptance, accessibility: WCAG 2.1 AA contrast measured on the rendered spread (computed
 * colours in the real engine, not the token tables), for the four paper surfaces in OS light and dark:
 * body text, running heads, page numbers and footnote text on the paper (4.5:1), and the Phase 2
 * toolbar and status bar controls on their bars (4.5:1). The token-level checks stay in
 * src/shared/theme/contrast.test.ts (SURFACE_CONTRAST_PAIRS) and header-footer/preview-contrast.test.ts.
 */

const SURFACES = ['auto', 'book', 'white', 'dark'] as const
const SCHEMES = ['light', 'dark'] as const

interface Sample {
  what: string
  fg: string
  bg: string
  ratio: number
}

/** In the page: contrast of each sampled element's text colour on its effective background. */
async function samples(page: Page): Promise<Sample[]> {
  return page.evaluate(() => {
    const parse = (c: string): [number, number, number, number] => {
      const m = c.match(/rgba?\(([^)]+)\)/)
      if (!m) return [0, 0, 0, 0]
      const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number)
      return [p[0], p[1], p[2], p[3] ?? 1]
    }
    const over = (top: number[], under: number[]) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3]))
    /** First ancestor (or self) with a non-transparent background, composited over white. */
    const bgOf = (el: Element): number[] => {
      const layers: number[][] = []
      for (let n: Element | null = el; n; n = n.parentElement) {
        const c = parse(getComputedStyle(n).backgroundColor)
        if (c[3] > 0) {
          layers.push(c)
          if (c[3] >= 1) break
        }
      }
      let out = [255, 255, 255]
      for (const l of layers.reverse()) out = over(l, out)
      return out
    }
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
    const out: { what: string; fg: string; bg: string; ratio: number }[] = []
    const add = (what: string, el: Element | null, bgEl?: Element | null) => {
      if (!el) return
      const fg = parse(getComputedStyle(el).color)
      const bg = bgOf(bgEl ?? el)
      const fgRgb = over(fg, bg)
      out.push({ what, fg: fgRgb.map(Math.round).join(','), bg: bg.map(Math.round).join(','), ratio: +ratio(fgRgb, bg).toFixed(2) })
    }
    // Text on the paper: the frame (.nv-page) is the paper behind the text layer.
    const frame = document.querySelector('.nv-frames .nv-page:not([data-blank])')
    add('body text', document.querySelector('.novel-editor-content > p'), frame)
    add('chapter title', document.querySelector('.novel-editor-content > h1'), frame)
    const head = Array.from(document.querySelectorAll('.nv-frames [data-hf="text"]')).find((e) => e.textContent)
    add('running head', head ?? null, head?.closest('.nv-page'))
    const num = Array.from(document.querySelectorAll('.nv-frames [data-hf="number"]')).find((e) => e.textContent)
    add('page number', num ?? null, num?.closest('.nv-page'))
    const note = document.querySelector('.nv-frames .nv-fn-area')
    add('footnote text', note, note?.closest('.nv-page'))
    // Phase 2 controls on the toolbar and the status bar.
    // Phase 3: Book mode's page-turn control, a paper tab on the desk (the enabled one; a disabled control is exempt).
    for (const id of ['book.trimSize', 'insert.menu', 'footnote.options', 'book.headerFooter', 'pagination.zoom', 'pagination.zoomIn', 'pagination.nextSpread'])
      add(`control ${id}`, document.querySelector(`[data-control-id="${id}"]`))
    add('page indicator', document.querySelector('[data-testid="page-indicator"]'))
    return out
  })
}

test('WCAG AA contrast on the rendered spread: four paper surfaces x OS light and dark', async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.emulateMedia({ colorScheme: 'light' })
  await launch(page)
  const fx = buildPaginationFixture({ words: 4000, chapters: 2 })
  const content = fx.doc.content as { type: string; content: unknown[] }[]
  // A footnote on the first page, so its area is drawn in view.
  content[1] = { ...content[1], content: [...content[1].content, { type: 'footnote', content: [{ type: 'text', text: 'A note on contrast.' }] }] }
  await seedProject(page, '/projects/Contrast', 'Contrast', { type: 'doc', content })
  await openRecent(page, '/projects/Contrast')
  await expect(saveStatus(page)).toHaveText('Contrast: All changes saved')
  await waitForLayout(page)
  expect((await page.evaluate(() => window.__nvE2E.layout())).effectiveView).toBe('spread')

  const failures: string[] = []
  let checked = 0
  let lowest = { ratio: Infinity, label: '' }
  for (const scheme of SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme })
    await expect(page.locator('html')).toHaveAttribute('data-theme', scheme)
    for (const surface of SURFACES) {
      await (await reveal(page, `book.surface.${surface}`)).click()
      const resolved = surface === 'auto' ? (scheme === 'light' ? 'white' : 'dark') : surface
      await expect(page.locator('html')).toHaveAttribute('data-surface', resolved)
      // Let the colour transitions (if any) finish before reading computed colours.
      await page.evaluate(() => new Promise((r) => setTimeout(r, 350)))
      // Book mode (the default) shows one spread: the first page is front matter (no running head),
      // so also sample the next spread.
      await showPage(page, 0)
      const got = await samples(page)
      if (await isBookMode(page)) {
        await showPage(page, 2)
        got.push(...(await samples(page)))
        await showPage(page, 0)
      }
      const names = got.map((s) => s.what)
      for (const must of ['body text', 'chapter title', 'running head', 'page number', 'footnote text', 'page indicator', 'control book.trimSize'])
        expect(names, `${scheme}/${surface}: sampled ${must}`).toContain(must)
      for (const s of got) {
        checked++
        if (s.ratio < lowest.ratio) lowest = { ratio: s.ratio, label: `${scheme}/${surface} ${s.what} (fg ${s.fg} on ${s.bg})` }
        if (s.ratio < 4.5) failures.push(`${scheme}/${surface} ${s.what}: ${s.ratio}:1 (fg ${s.fg} on ${s.bg})`)
      }
    }
  }
  console.info(`[contrast] ${checked} samples checked; lowest ${lowest.ratio}:1, ${lowest.label}`)
  expect(failures).toEqual([])
})
