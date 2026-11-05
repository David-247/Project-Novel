import { expect, type TestInfo } from '@playwright/test'

/**
 * Perf budget gate (Vibeless decisions afbe3475, f040009b). Budgets block only on the shipping pairs:
 * macOS + WebKit (WKWebView) and Windows + Chromium (WebView2). In CI, macOS budgets do not block
 * either: GitHub's free macOS runner (a shared 3-core M1) misses them on commits that change no app
 * code, so there a macOS miss is a warning; run the perf specs on a real Mac to enforce them.
 * Wherever a budget does not block, the measurement still runs and is reported; a miss is a warning
 * (test annotation + console line), not a failure. Functional assertions are never routed through here.
 *
 * A measure the free CI runners keep missing for runner rather than app reasons is CI-advisory
 * (`{ ciAdvisory: true }`): in CI it is reported, never blocking, on every pair; outside CI it blocks
 * on the shipping pairs like any budget. Each use names the decision behind it.
 */
export interface BudgetOptions {
  /** Reported, not blocking, in CI (still blocking locally on the shipping pairs). */
  ciAdvisory?: boolean
}
export type Engine = 'chromium' | 'webkit' | 'firefox'

/** The project's browser engine, from its configuration (`use.browserName` / `defaultBrowserType`). */
export function engineOf(testInfo: TestInfo): Engine | null {
  const use = testInfo.project.use as { browserName?: string; defaultBrowserType?: string }
  const name = use.browserName ?? use.defaultBrowserType
  return name === 'chromium' || name === 'webkit' || name === 'firefox' ? name : null
}

export function isShippingPair(testInfo: TestInfo, platform: NodeJS.Platform = process.platform): boolean {
  const engine = engineOf(testInfo)
  if (!engine) {
    // A gate that guesses wrong would silently stop blocking: on CI an unknown engine is an error.
    if (process.env.CI) throw new Error(`perf budget: unknown browser engine for project "${testInfo.project.name}"`)
    return false
  }
  return (platform === 'darwin' && engine === 'webkit') || (platform === 'win32' && engine === 'chromium')
}

/**
 * Whether a budget miss fails the test here: a shipping pair, except macOS in CI (decision f040009b)
 * and CI-advisory measures in CI.
 */
export function budgetBlocks(
  testInfo: TestInfo,
  platform: NodeJS.Platform = process.platform,
  ci: boolean = !!process.env.CI,
  opts: BudgetOptions = {},
): boolean {
  if (ci && opts.ciAdvisory) return false
  return isShippingPair(testInfo, platform) && !(ci && platform === 'darwin')
}

/** Assert `value < limit` where budgets block (see budgetBlocks); elsewhere warn on a miss. Returns whether it was within budget. */
export function budget(testInfo: TestInfo, name: string, value: number, limit: number, opts: BudgetOptions = {}): boolean {
  const ok = value < limit
  if (budgetBlocks(testInfo, process.platform, !!process.env.CI, opts)) {
    expect(value, `${name} (budget ${limit})`).toBeLessThan(limit)
    return ok
  }
  if (!ok) {
    const description = `${name}: ${value} >= ${limit} on ${testInfo.project.name} / ${process.platform} (${opts.ciAdvisory && process.env.CI ? 'CI-advisory measure' : isShippingPair(testInfo) ? 'macOS CI runner' : 'not a shipping pair'}: reported, not blocking)`
    testInfo.annotations.push({ type: 'perf-budget-warning', description })
    console.warn(`[perf-budget-warning] ${description}`)
  }
  return ok
}
