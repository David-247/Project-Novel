import { expect, test } from '@playwright/test'

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

test('100k-word paste stays responsive', async ({ page }) => {
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

  // Next keystroke latency after the paste (event -> DOM updated).
  const keyMs = await page.evaluate(async () => {
    const t0 = performance.now()
    document.execCommand('insertText', false, 'x')
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    return performance.now() - t0
  })
  console.info(`[perf] chromium keystroke after paste: ${keyMs.toFixed(1)} ms`)
  expect(pasteMs).toBeLessThan(5000)
})
