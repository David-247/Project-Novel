#!/usr/bin/env node
/**
 * T6: screenshots of the ribbon (the toolbar) at several window widths in OS light and dark, plus
 * one shot per tab, for review. Not part of any test run.
 *
 *   node scripts/capture-ribbon.mjs [outDir] [--no-build]
 *
 * Builds the e2e web app (fake Tauri backend), serves it with `vite preview`, seeds a small
 * manuscript through window.__nvE2E and writes `ribbon-<width>-<scheme>.png`,
 * `ribbon-1100-light-<tab>.png`, `ribbon-<width>-light-open.png` (the More menu or a collapsed
 * group open) and `statusbar-480-<scheme>[-noproject].png` (the bottom of the window).
 */
/* global window */
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from '@playwright/test'

const args = process.argv.slice(2)
const outDir = resolve(args.find((a) => !a.startsWith('--')) ?? 'toolbar-proto-shots')
const port = Number(process.env.PW_PORT ?? 4191)
const base = `http://127.0.0.1:${port}`
const WIDTHS = [1280, 1100, 800, 600, 480]
const SCHEMES = ['light', 'dark']
const VARIANTS = ['ribbon']
const HEIGHT = 720
const CLIP_H = 300

mkdirSync(outDir, { recursive: true })
const shell = process.platform === 'win32'
if (!args.includes('--no-build')) {
  const b = spawnSync('pnpm', ['build:e2e'], { stdio: 'inherit', shell })
  if (b.status !== 0) process.exit(b.status ?? 1)
}
const server = spawn('pnpm', ['exec', 'vite', 'preview', '--mode', 'e2e', '--outDir', 'dist-e2e', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  stdio: 'ignore',
  shell,
})

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(base)).ok) return
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('vite preview did not start')
}

const t = (text, marks) => ({ type: 'text', text, ...(marks ? { marks } : {}) })
const p = (...content) => ({ type: 'paragraph', content })
const DOC = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1 }, content: [t('Chapter One: The Lantern Keeper')] },
    p(
      t('The harbor was quiet that morning, and Mara walked the long stone quay with the '),
      t('letter', [{ type: 'bold' }]),
      t(' folded twice inside her coat. Somewhere behind the warehouses a bell began to ring, slow and uneven, the way it only rang for ships that were not coming back.'),
    ),
    p(t('“You read it, then,” said Tomas, who had been waiting by the lantern house since before dawn.')),
    p(t('“I read it.” She did not look at him. '), t('Not yet,', [{ type: 'italic' }]), t(' she thought. Not until the tide turned.')),
    p(
      t('The lantern above them had burned for ninety years without once going dark. Her grandmother had trimmed its wick through two wars and a winter so cold the bay froze to the outer rocks, and her mother after that, and now the brass key hung from Mara’s own neck on a ribbon gone grey with salt.'),
    ),
    p(t('“They want to close it,” Tomas said. “The council. They say the new beacon at Hallow Point makes it unnecessary.”')),
  ],
}

async function shoot(browser, variant, width, scheme, extra) {
  const ctx = await browser.newContext({ viewport: { width, height: HEIGHT }, colorScheme: scheme, deviceScaleFactor: 1 })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.error(`[pageerror ${variant}-${width}-${scheme}] ${e.message}`))
  await page.goto(`${base}/`)
  await page.locator('main [contenteditable="true"]').waitFor()
  await page.waitForFunction(() => !!window.__nvE2E)
  if (variant === 'statusbar' && extra === 'noproject') {
    // No project, some unsaved text: the New / Open / Save as project buttons are in the status bar.
    await page.locator('main [contenteditable="true"]').click()
    await page.keyboard.type('Some unsaved words.')
    await page.waitForTimeout(500)
    await page.screenshot({ path: resolve(outDir, `statusbar-${width}-${scheme}-noproject.png`), clip: { x: 0, y: HEIGHT - 120, width, height: 120 } })
    console.log(`statusbar-${width}-${scheme}-noproject`)
    await ctx.close()
    return
  }
  await page.evaluate(async (doc) => {
    const e2e = window.__nvE2E
    const now = new Date(Date.now() - 60_000).toISOString()
    const folder = '/projects/The Lantern Keeper'
    await e2e.writeFile(`${folder}/project.json`, JSON.stringify({ format: 'novel-project', schemaVersion: 1, id: 'proto', title: 'The Lantern Keeper', createdAt: now, updatedAt: now }))
    await e2e.writeFile(`${folder}/manuscript.json`, JSON.stringify(doc))
    e2e.addRecent(folder, 'The Lantern Keeper')
    await e2e.emit('menu://open-recent', folder)
  }, DOC)
  await page.locator('footer[aria-label="Status bar"]').getByText('All changes saved').waitFor({ timeout: 15_000 })
  await page.waitForFunction(() => window.__nvE2E.paginationSettled())
  // Caret inside the bold word, so Bold shows as on.
  await page.locator('main strong').first().click()
  await page.waitForTimeout(500)
  let suffix = ''
  if (variant === 'statusbar') {
    await page.screenshot({ path: resolve(outDir, `statusbar-${width}-${scheme}.png`), clip: { x: 0, y: HEIGHT - 120, width, height: 120 } })
    console.log(`statusbar-${width}-${scheme}`)
    await ctx.close()
    return
  }
  if (extra === 'open') {
    suffix = '-open'
    const more = page.locator('[data-control-id="ribbon.more"]:visible')
    const trigger = (await more.count()) ? more : page.locator('[role="tabpanel"]:visible [data-control-id^="ribbon.group."]').first()
    await trigger.click()
    await page.waitForTimeout(300)
    if (await more.count()) {
      await page.locator('[role="menu"] [data-control-id^="ribbon.group."]').first().hover()
      await page.waitForTimeout(300)
    }
  } else if (extra) {
    suffix = `-${extra}`
    await page.locator(`[data-control-id="ribbon.tab.${extra}"]`).click()
    await page.waitForTimeout(400)
  }
  const file = resolve(outDir, `${variant}-${width}-${scheme}${suffix}.png`)
  await page.screenshot({ path: file, clip: { x: 0, y: 0, width, height: extra === 'open' ? 560 : CLIP_H } })
  const header = await page.locator('header[role="banner"]').boundingBox()
  console.log(`${variant}-${width}-${scheme}${suffix}: header ${Math.round(header.height)}px`)
  await ctx.close()
}

try {
  await waitForServer()
  const browser = await chromium.launch()
  for (const variant of VARIANTS) for (const scheme of SCHEMES) for (const w of WIDTHS) await shoot(browser, variant, w, scheme)
  for (const tab of ['home', 'insert', 'layout', 'review', 'view']) await shoot(browser, 'ribbon', 1100, 'light', tab)
  for (const w of [800, 480]) await shoot(browser, 'ribbon', w, 'light', 'open')
  for (const scheme of SCHEMES) {
    await shoot(browser, 'statusbar', 480, scheme)
    await shoot(browser, 'statusbar', 480, scheme, 'noproject')
  }
  await browser.close()
} finally {
  server.kill()
  if (shell && server.pid) spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' })
}
