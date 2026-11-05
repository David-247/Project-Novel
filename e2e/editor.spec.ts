import { expect, test } from '@playwright/test'
import { budget } from './budget'
import { turnSettled } from './helpers'

test('user types into the editor in the OS system font', async ({ page }) => {
  await page.goto('/')
  const editor = page.getByRole('textbox', { name: 'Manuscript' })
  await editor.click()
  await page.keyboard.type('Hello novel')
  await expect(editor).toContainText('Hello novel')
  const font = await editor.evaluate((el) => getComputedStyle(el).fontFamily)
  expect(font).toMatch(/^system-ui/)
  await expect(page.getByRole('combobox', { name: 'Font family' })).toBeEnabled()
})

test('100k-word paste stays responsive', async ({ page }, testInfo) => {
  await page.goto('/')
  const editor = page.getByRole('textbox', { name: 'Manuscript' })
  await editor.click()
  const pasteMs = await editor.evaluate((el) => {
    const para = Array.from({ length: 100 }, (_, i) => `word${i}`).join(' ')
    const text = Array.from({ length: 1000 }, () => para).join('\n\n')
    const data = new DataTransfer()
    data.setData('text/plain', text)
    const t0 = performance.now()
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    return performance.now() - t0
  })
  console.info(`[perf] chromium 100k-word paste dispatch: ${pasteMs.toFixed(0)} ms`)
  await expect(editor.locator('p')).toHaveCount(1000)
  // The paste's own pagination (laying out 1,000 new paragraphs) is the paste's cost, not a
  // keystroke's: wait for the page model and every block to be drawn before measuring keystrokes.
  await page.waitForFunction(() => window.__nvE2E.paginationSettled(), undefined, { timeout: 30_000 })
  // Book mode (the default) turns to the caret's spread at the end of the paste: let the turn finish.
  await turnSettled(page)

  // Keystroke latency after the paste (input -> DOM updated -> next frame), median of 5.
  const keyMs = await page.evaluate(async () => {
    const samples: number[] = []
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now()
      document.execCommand('insertText', false, 'x')
      await new Promise((r) => requestAnimationFrame(() => r(null)))
      samples.push(performance.now() - t0)
    }
    samples.sort((a, b) => a - b)
    return samples[2]
  })
  console.info(`[perf] chromium keystroke after paste (median of 5): ${keyMs.toFixed(1)} ms`)
  budget(testInfo, 'paste dispatch ms', pasteMs, 5000)
  budget(testInfo, 'keystroke after paste ms', keyMs, 50)
})
