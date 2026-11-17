import { expect, test } from '@playwright/test'
import { budgetBlocks, engineOf } from './budget'

// The perf gate decides blocking vs warning from the project's configured engine, not its name.
test('perf budget gate reads the engine from the project configuration', ({ browserName }, testInfo) => {
  expect(engineOf(testInfo)).toBe(browserName)
})

// Decision f040009b: in CI only Windows Chromium blocks; macOS (free shared runner) warns. Locally the
// shipping pairs block on both OSes.
test('perf budgets block in CI only on Windows Chromium, locally on both shipping pairs', ({ browserName }, testInfo) => {
  expect(budgetBlocks(testInfo, 'win32', true)).toBe(browserName === 'chromium')
  expect(budgetBlocks(testInfo, 'darwin', true)).toBe(false)
  expect(budgetBlocks(testInfo, 'darwin', false)).toBe(browserName === 'webkit')
  expect(budgetBlocks(testInfo, 'win32', false)).toBe(browserName === 'chromium')
})

// A CI-advisory measure (free runners miss it for runner reasons) never blocks in CI, on any pair, and
// blocks locally exactly where an ordinary budget does.
test('a CI-advisory budget reports in CI and blocks locally on the shipping pairs', ({ browserName }, testInfo) => {
  const advisory = { ciAdvisory: true }
  for (const os of ['win32', 'darwin'] as const) expect(budgetBlocks(testInfo, os, true, advisory)).toBe(false)
  expect(budgetBlocks(testInfo, 'win32', false, advisory)).toBe(browserName === 'chromium')
  expect(budgetBlocks(testInfo, 'darwin', false, advisory)).toBe(browserName === 'webkit')
  // Without the flag nothing changes.
  expect(budgetBlocks(testInfo, 'win32', true, {})).toBe(browserName === 'chromium')
})
