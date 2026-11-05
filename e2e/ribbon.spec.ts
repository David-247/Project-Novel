import { expect, test, type Page } from '@playwright/test'
import { editor, launch, reveal, ribbonTab, type RibbonTab } from './helpers'

/**
 * The ribbon (T6): one fixed-height row at every width, groups scaling down step by step with no
 * flicker, every command reachable, keyboard access to collapsed groups and the overflow, formatting
 * from a dropdown keeping the manuscript's selection, and the selected tab kept for the session.
 */

const header = (page: Page) => page.getByRole('banner', { name: 'App controls' })
const panel = (page: Page, tab: RibbonTab) => page.locator(`[data-ribbon-panel="${tab}"]`)

/** The shown step of a tab, whether its row overflows, and each group's state. */
const snapshot = (page: Page, tab: RibbonTab) =>
  panel(page, tab).evaluate((el) => {
    const inner = el.firstElementChild as HTMLElement
    return {
      step: Number(el.getAttribute('data-ribbon-step')),
      overflows: inner.offsetWidth > (el as HTMLElement).clientWidth + 1,
      groups: Object.fromEntries(
        Array.from(el.querySelectorAll('[data-ribbon-group]'), (g) => [g.getAttribute('data-ribbon-group'), g.getAttribute('data-ribbon-state')]),
      ),
    }
  })

/** Wait for the ribbon to settle (layout effects run before paint; two frames is plenty). */
const settle = (page: Page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))

async function resize(page: Page, width: number) {
  await page.setViewportSize({ width, height: 700 })
  await settle(page)
}

for (const tab of ['home', 'insert', 'layout', 'review', 'view'] as const) {
  test(`${tab} tab: resizing step by step keeps one row, a constant height and a stable placement`, async ({ page }) => {
    test.setTimeout(120_000) // about 100 resizes
    await page.setViewportSize({ width: 1400, height: 700 })
    await launch(page)
    await ribbonTab(page, tab)
    const height = (await header(page).boundingBox())!.height
    const canvasTop = (await page.locator('main').boundingBox())!.y

    const widths: number[] = []
    for (let w = 1400; w >= 480; w -= 20) widths.push(w)
    const down: number[] = []
    for (const w of widths) {
      await resize(page, w)
      const a = await snapshot(page, tab)
      expect(a.overflows, `row overflows at ${w}px`).toBe(false)
      expect((await header(page).boundingBox())!.height).toBe(height)
      expect((await page.locator('main').boundingBox())!.y).toBe(canvasTop)
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(w)
      // No flicker: the placement holds a moment later.
      await page.waitForTimeout(60)
      expect((await snapshot(page, tab)).step, `step changed on its own at ${w}px`).toBe(a.step)
      down.push(a.step)
    }
    // Narrowing only ever gives up room.
    for (let i = 1; i < down.length; i++) expect(down[i]).toBeGreaterThanOrEqual(down[i - 1])

    const up: number[] = []
    for (const w of [...widths].reverse()) {
      await resize(page, w)
      const a = await snapshot(page, tab)
      expect(a.overflows, `row overflows at ${w}px (growing)`).toBe(false)
      up.push(a.step)
    }
    for (let i = 1; i < up.length; i++) expect(up[i]).toBeLessThanOrEqual(up[i - 1])
    // Hysteresis: growing back never shows a bigger step than shrinking showed at the same width,
    // and back at full width everything is full again.
    expect(up[up.length - 1]).toBe(down[0])

    // Jitter around each boundary (±2px) does not flip a group back and forth.
    const boundaries = down.flatMap((s, i) => (i > 0 && s !== down[i - 1] ? [widths[i]] : []))
    for (const b of boundaries.slice(0, 4)) {
      await resize(page, b)
      const at = (await snapshot(page, tab)).step
      for (const w of [b + 2, b, b + 2, b]) {
        await resize(page, w)
        expect((await snapshot(page, tab)).step).toBe(at)
      }
    }
  })
}

/**
 * Per group, commands that must stay reachable: [control in the bar, item in a dropdown]. The dropdown
 * item is the registry command (or registry submenu, `menu.<menu>.<label>`) that a collapsed group, the
 * compact group's own menu or More shows when the bar control is not visible.
 */
const REACH: Record<RibbonTab, Record<string, [string, string][]>> = {
  home: {
    'home.font': [['toolbar.fontFamily', 'menu.format.font'], ['toolbar.fontSize', 'menu.format.font-size'], ['toolbar.bold', 'toolbar.bold'], ['toolbar.underline', 'toolbar.underline']],
    'home.paragraph': [
      ['toolbar.bulletList', 'toolbar.bulletList'],
      ['toolbar.alignJustify', 'toolbar.alignJustify'],
      ['toolbar.lineSpacing', 'menu.format.line-spacing'],
      ['toolbar.paragraphSpacing', 'menu.format.space-after'],
      ['toolbar.firstLineIndent', 'menu.format.first-line-indent'],
      ['toolbar.indentIncrease', 'toolbar.indentIncrease'],
    ],
    'home.styles': [['styles.picker', 'menu.format.paragraph-style'], ['styles.manage', 'styles.manage'], ['styles.clearFormatting', 'styles.clearFormatting']],
    'home.editing': [['find.open', 'find.open'], ['ribbon.cmd.edit.replace', 'edit.replace']],
  },
  insert: {
    'insert.breaks': [['ribbon.cmd.insert.pageBreak', 'insert.pageBreak'], ['ribbon.cmd.insert.newChapter', 'insert.newChapter'], ['insert.menu', 'insert.chapterStart.recto']],
    'insert.footnotes': [['ribbon.cmd.footnote.insert', 'footnote.insert'], ['footnote.options', 'footnote.options']],
    'insert.comments': [['ribbon.cmd.insert.comment', 'insert.comment']],
  },
  layout: {
    'layout.pageSetup': [['book.trimSize', 'menu.file.page-setup']],
    'layout.headers': [['book.headerFooter', 'book.headerFooter']],
    'layout.paper': [['book.surface.dark', 'menu.view.paper']],
    'layout.book': [['ribbon.cmd.book.details', 'book.details']],
  },
  review: {
    'review.tracking': [['review.track', 'review.track'], ['review.markup', 'menu.view.markup']],
    'review.changes': [
      ['ribbon.cmd.review.change.prev', 'review.change.prev'],
      ['ribbon.cmd.review.change.next', 'review.change.next'],
      ['ribbon.cmd.review.accept', 'review.accept'],
      ['review.accept.options', 'menu.review.accept-all-by-author'],
      ['ribbon.cmd.review.reject', 'review.reject'],
      ['review.reject.options', 'menu.review.reject-all-by-author'],
    ],
    'review.comments': [['comment.new', 'comment.new'], ['ribbon.cmd.comment.prev', 'comment.prev'], ['ribbon.cmd.comment.next', 'comment.next']],
    'review.rewrite': [
      ['ribbon.cmd.rewrite.open', 'rewrite.open'],
      ['ribbon.cmd.rewrite.list', 'rewrite.list'],
      ['ribbon.cmd.rewrite.prev', 'rewrite.prev'],
      ['ribbon.cmd.rewrite.next', 'rewrite.next'],
    ],
  },
  view: {
    'view.views': [['ribbon.cmd.view.singlePage', 'view.singlePage'], ['ribbon.cmd.pagination.spreadView', 'pagination.spreadView']],
    'view.zoom': [['ribbon.cmd.pagination.zoomIn', 'pagination.zoomIn'], ['ribbon.cmd.view.fitWidth', 'view.fitWidth'], ['ribbon.cmd.view.actualSize', 'view.actualSize']],
    'view.show': [['comment.panel', 'comment.panel']],
    'view.window': [['ribbon.cmd.view.fullScreen', 'view.fullScreen']],
  },
}

/** How `barId` of `group` is reached right now: 'bar', or the dropdown that lists `menuId`; null if not at all. */
async function reach(page: Page, tab: RibbonTab, group: string, barId: string, menuId: string): Promise<string | null> {
  const row = panel(page, tab)
  if (await row.locator(`[data-control-id="${barId}"]`).isVisible()) return 'bar'
  // The group's own menus (compact "Spacing", Break Options…), then its collapsed button, then More.
  const own = await row
    .locator(`[data-ribbon-group="${group}"] [aria-haspopup="menu"][data-control-id]`)
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-control-id')!))
  for (const trigger of [...own, `ribbon.group.${group}`, 'ribbon.more']) {
    const t = row.locator(`[data-control-id="${trigger}"]`)
    if (!(await t.isVisible())) continue
    await t.click()
    const menu = page.getByRole('menu').first()
    await expect(menu).toBeVisible()
    const found = await menu.locator(`[data-control-id="${menuId}"]`).isVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toHaveCount(0)
    if (found) return trigger
  }
  return null
}

for (const tab of ['home', 'insert', 'layout', 'review', 'view'] as const) {
  test(`every ${tab} command is reachable at 1100, 800, 600 and 480 px`, async ({ page }) => {
    test.setTimeout(90_000)
    await launch(page)
    await ribbonTab(page, tab)
    for (const w of [1100, 800, 600, 480]) {
      await resize(page, w)
      const { groups } = await snapshot(page, tab)
      expect(Object.keys(groups).sort(), `${tab} groups`).toEqual(Object.keys(REACH[tab]).sort())
      for (const [group, pairs] of Object.entries(REACH[tab])) {
        for (const [barId, menuId] of pairs) {
          const how = await reach(page, tab, group, barId, menuId)
          expect(how, `${barId} (${group}, ${groups[group]}) at ${w}px`).not.toBeNull()
        }
      }
    }
  })
}

test('dropdown items keep their labels, shortcuts and checked state', async ({ page }) => {
  await launch(page)
  await resize(page, 480)
  await page.locator('[data-control-id="ribbon.group.home.paragraph"]').click()
  const align = page.getByRole('menuitemcheckbox', { name: /^Left/ })
  await expect(align).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByRole('menu')).toContainText(/Ctrl\+Shift\+L|⇧⌘L/)
  await page.keyboard.press('Escape')
})

test('below the minimum width, groups move into More; it lists them with their commands', async ({ page }) => {
  await launch(page)
  await resize(page, 360)
  const { groups, overflows } = await snapshot(page, 'home')
  expect(overflows).toBe(false)
  const inMore = Object.entries(groups).filter(([, s]) => s === 'overflow').map(([id]) => id)
  expect(inMore.length).toBeGreaterThan(0)
  await page.locator('[data-control-id="ribbon.more"]').click()
  const menu = page.getByRole('menu')
  const names: Record<string, string> = { 'home.font': 'Font', 'home.paragraph': 'Paragraph', 'home.styles': 'Styles', 'home.editing': 'Editing' }
  for (const id of inMore) await expect(menu.getByRole('group', { name: names[id] })).toBeVisible()
  expect(await menu.locator('[data-control-id]').count()).toBeGreaterThan(0)
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
})

test('collapsed groups and More work from the keyboard; Escape returns focus to the button', async ({ page }) => {
  await launch(page)
  for (const [width, id] of [
    [480, 'ribbon.group.home.paragraph'],
    [360, 'ribbon.more'],
  ] as const) {
    await resize(page, width)
    const trigger = page.locator(`[data-control-id="${id}"]`)
    await trigger.focus()
    await page.keyboard.press('Enter')
    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible()
    await page.keyboard.press('ArrowDown')
    await expect(menu.locator(':focus')).toHaveCount(1)
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
    await expect(trigger).toBeFocused()
  }

  // Roving focus: from the row, Home goes to the start (the tabs; Undo and Redo are disabled), the
  // arrows move along the tabs, End goes to the last control of the row.
  await page.keyboard.press('Home')
  await expect(page.locator('[data-control-id="ribbon.tab.home"]')).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(page.locator('[data-control-id="ribbon.tab.insert"]')).toBeFocused()
  await page.keyboard.press('End')
  await expect(page.locator('[data-control-id="ribbon.more"]')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.locator('main [contenteditable="true"]')).toBeFocused()
})

test('formatting from a collapsed group keeps the manuscript focus and selection', async ({ page }) => {
  await launch(page)
  await editor(page).click()
  await page.keyboard.type('one two three')
  // Select "two".
  await page.keyboard.press('End')
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowLeft')
  for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowLeft')
  await resize(page, 480)
  const font = page.locator('[data-control-id="ribbon.group.home.font"]')
  await expect(font).toBeVisible()
  await font.click()
  await page.getByRole('menuitemcheckbox', { name: /^Bold/ }).click()
  await expect(editor(page).locator('strong')).toHaveText('two')
  await expect(editor(page)).toBeFocused()
  // The selection is still "two": typing replaces it.
  await page.keyboard.type('2')
  await expect(editor(page)).toContainText('one 2 three')
})

test('the selected tab is kept for the session', async ({ page }) => {
  await launch(page)
  await ribbonTab(page, 'review')
  await expect(page.locator('[data-control-id="review.track"]')).toBeVisible()
  await launch(page) // reload in the same session
  await expect(page.locator('[data-control-id="ribbon.tab.review"]')).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('[data-control-id="review.track"]')).toBeVisible()
})

/**
 * Contrast problems under `root` (a CSS selector): text of every visible, enabled control (and of its
 * spans: menu shortcuts) below 4.5:1, and icons (`icons` selector, non-text) below 3:1, on the effective
 * background.
 */
const contrast = (page: Page, root: string, icons: string) =>
  page.evaluate(
    ([rootSel, iconSel]) => {
      const parse = (c: string) => {
        const p = (c.match(/rgba?\(([^)]+)\)/)?.[1] ?? '0,0,0,0').split(/[ ,/]+/).filter(Boolean).map(Number)
        return [p[0], p[1], p[2], p[3] ?? 1]
      }
      const bgOf = (el: Element) => {
        const layers: number[][] = []
        for (let n: Element | null = el; n; n = n.parentElement) {
          const c = parse(getComputedStyle(n).backgroundColor)
          if (c[3] > 0) {
            layers.push(c)
            if (c[3] >= 1) break
          }
        }
        let out = [255, 255, 255]
        for (const l of layers.reverse()) out = [0, 1, 2].map((i) => l[i] * l[3] + out[i] * (1 - l[3]))
        return out
      }
      const lum = (rgb: number[]) => {
        const [r, g, b] = rgb.map((v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4))
        return 0.2126 * r + 0.7152 * g + 0.0722 * b
      }
      const ratio = (el: Element) => {
        const bg = bgOf(el)
        const fg = parse(getComputedStyle(el).color)
        const mixed = [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3]))
        const [x, y] = [lum(mixed), lum(bg)].sort((p, q) => q - p)
        return (x + 0.05) / (y + 0.05)
      }
      const out: string[] = []
      for (const r of document.querySelectorAll(rootSel)) {
        for (const el of r.querySelectorAll<HTMLElement>('[data-control-id]')) {
          if (!el.checkVisibility() || el.matches(':disabled, [aria-disabled="true"], [data-disabled]')) continue
          // The paper swatches show the paper itself; their labels and rings are checked in surface.spec.
          if (el.getAttribute('data-control-id')?.startsWith('book.surface.')) continue
          for (const t of [el, ...el.querySelectorAll('span')]) {
            if (!t.checkVisibility() || !t.textContent?.trim() || t.getAttribute('aria-hidden') === 'true') continue
            const v = ratio(t)
            if (v < 4.5) out.push(`${el.getAttribute('data-control-id')} text "${t.textContent.trim().slice(0, 20)}" ${v.toFixed(2)}`)
          }
        }
        for (const icon of r.querySelectorAll(iconSel)) {
          if (!icon.checkVisibility()) continue
          const v = ratio(icon)
          if (v < 3) out.push(`${icon.closest('[data-control-id]')?.getAttribute('data-control-id')} icon ${v.toFixed(2)}`)
        }
      }
      return out
    },
    [root, icons] as const,
  )

const BAR = '[role="toolbar"][aria-label="Formatting"]'
const MENU = '[data-nv-menu-content]'
const GROUP_ICONS = '[data-control-id^="ribbon.group."] > span[aria-hidden="true"], [data-control-id="ribbon.more"] > svg'

test('ribbon text and icons meet WCAG AA on the four papers in OS light and dark, wide and narrow, menus open', async ({ page }) => {
  test.setTimeout(180_000)
  await launch(page)
  const low: string[] = []
  const add = (where: string, found: string[]) => low.push(...found.map((f) => `${where}: ${f}`))
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    for (const surface of ['auto', 'book', 'white', 'dark'] as const) {
      await resize(page, 1280) // the paper swatches are a dropdown at narrow widths
      await (await reveal(page, `book.surface.${surface}`)).click()
      await page.mouse.move(700, 600)
      for (const width of [1280, 480]) {
        await resize(page, width)
        for (const tab of ['home', 'insert', 'layout', 'review', 'view'] as const) {
          await ribbonTab(page, tab)
          add(`${scheme}/${surface}/${width}/${tab}`, await contrast(page, BAR, GROUP_ICONS))
        }
      }
      // An open collapsed group (with a check mark, shortcuts and a submenu) and the More menu.
      await ribbonTab(page, 'home')
      await page.locator('[data-control-id="ribbon.group.home.paragraph"]').click()
      await expect(page.getByRole('menu')).toBeVisible()
      await page.keyboard.press('ArrowDown') // a highlighted item too
      add(`${scheme}/${surface}/paragraph menu`, await contrast(page, MENU, `${MENU} svg`))
      await page.keyboard.press('Escape')
      await resize(page, 360)
      await panel(page, 'home').locator('[data-control-id="ribbon.more"]').click() // each tab's panel has its own More
      await expect(page.getByRole('menu')).toBeVisible()
      add(`${scheme}/${surface}/More`, await contrast(page, MENU, `${MENU} svg`))
      await page.keyboard.press('Escape')
      add(`${scheme}/${surface}/360`, await contrast(page, BAR, GROUP_ICONS))
    }
  }
  expect(low).toEqual([])
})
