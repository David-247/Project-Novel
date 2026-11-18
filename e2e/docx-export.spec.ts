import { expect, test } from '@playwright/test'
import { buildPaginationFixture } from './fixtures/pagination-manuscript'
import { launch, waitForLayout } from './helpers'

/**
 * The DOCX renderer in the built app (src/features/export/docx): it runs in a real Web Worker, and
 * cancelling stops it at once with an AbortError and no bytes (so the caller writes no file).
 * Speed: e2e/perf-export.spec.ts.
 */

test('cancelling a DOCX export rejects with an AbortError and returns no file', async ({ page }) => {
  test.setTimeout(120_000)
  await launch(page)
  await page.evaluate((d) => window.__nvE2E.setDoc(d), buildPaginationFixture().doc)
  await waitForLayout(page)
  const r = await page.evaluate(() => window.__nvE2E.cancelDocxRender(10))
  expect(r).toMatchObject({ resolved: false, bytes: 0, error: 'AbortError', progressAfterCancel: 0 })
  // The worker is terminated, not waited for.
  expect(r!.settledMs).toBeLessThan(2000)
})

test('a DOCX export in the worker produces a .docx', async ({ page }) => {
  const workerScripts: string[] = []
  page.on('worker', (w) => workerScripts.push(w.url()))
  await launch(page)
  await page.evaluate((d) => window.__nvE2E.setDoc(d), buildPaginationFixture({ words: 3000, chapters: 3 }).doc)
  await waitForLayout(page)
  const r = await page.evaluate(() => window.__nvE2E.renderDocxTimes(1))
  expect(r!.bytes).toBeGreaterThan(5000)
  expect(r!.fractions[r!.fractions.length - 1]).toBe(1)
  // Built off the main thread (one worker per render: the warm-up and the measured run).
  expect(workerScripts.filter((u) => /worker/.test(u)).length).toBeGreaterThanOrEqual(2)
})
