import { defineConfig, devices } from '@playwright/test'

/**
 * Device presets minus their userAgent: 'Desktop Chrome' claims Windows, which (via
 * navigator.userAgentData) makes the app render Ctrl shortcuts while Playwright's ControlOrMeta
 * sends Cmd on macOS hosts. The host's real UA keeps app platform detection and keys in sync.
 */
const desktop = (name: 'Desktop Chrome' | 'Desktop Safari') => {
  const { userAgent, ...rest } = devices[name]
  void userAgent
  return rest
}

// E2E runs against the built web app (`vite build --mode e2e`, served by `vite preview`) with the
// fake Tauri backend from src/test-utils/e2e-backend.ts (real-app WebDriver is unavailable for
// macOS WKWebView). chromium stands in for WebView2, webkit for WKWebView.
// PW_PORT overrides the port (use a unique one when several worktrees run e2e at once).
const port = Number(process.env.PW_PORT ?? 4174)
const baseURL = `http://127.0.0.1:${port}`
// Serial (perf) projects: the perf specs, and the Phase 2 acceptance scenario, whose reflow budgets
// (blocking on the shipping pairs) need a quiet CPU, not one shared with parallel functional tests.
const PERF = /(perf|phase2-acceptance)\.spec\.ts$/

export default defineConfig({
  testDir: './e2e',
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  retries: process.env.CI ? 1 : 0,
  use: { baseURL, trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium', use: desktop('Desktop Chrome'), testIgnore: PERF },
    { name: 'webkit', use: desktop('Desktop Safari'), testIgnore: PERF },
    // Perf runs alone: only after both functional projects finished, and one browser at a time,
    // so no other test competes for the CPU while latency is measured. (If a functional test
    // fails, the perf projects are skipped; CI therefore runs them in a separate job with
    // `--project=perf-chromium --project=perf-webkit --no-deps --workers=1`.)
    {
      name: 'perf-chromium',
      use: desktop('Desktop Chrome'),
      // A budget miss must fail: no retry for perf.
      retries: 0,
      testMatch: PERF,
      dependencies: ['chromium', 'webkit'],
    },
    {
      name: 'perf-webkit',
      use: desktop('Desktop Safari'),
      retries: 0,
      testMatch: PERF,
      dependencies: ['perf-chromium'],
    },
  ],
  webServer: {
    command: `pnpm build:e2e && pnpm exec vite preview --mode e2e --outDir dist-e2e --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
})
