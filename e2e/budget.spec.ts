import { expect, test } from '@playwright/test'
import { engineOf } from './budget'

// The perf gate decides blocking vs warning from the project's configured engine, not its name.
test('perf budget gate reads the engine from the project configuration', ({ browserName }, testInfo) => {
  expect(engineOf(testInfo)).toBe(browserName)
})
