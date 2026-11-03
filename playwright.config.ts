import { defineConfig, devices } from '@playwright/test'

// E2E runs against the built web app (`vite build --mode e2e`, served by `vite preview`) with the
// fake Tauri backend from src/test-utils/e2e-backend.ts (real-app WebDriver is unavailable for
// macOS WKWebView). chromium stands in for WebView2, webkit for WKWebView.
// PW_PORT overrides the port (use a unique one when several worktrees run e2e at once).
const port = Number(process.env.PW_PORT ?? 4174)
const baseURL = `http://127.0.0.1:${port}`

export default defineConfig({
  testDir: './e2e',
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  retries: process.env.CI ? 1 : 0,
  use: { baseURL, trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: `pnpm build:e2e && pnpm exec vite preview --mode e2e --outDir dist-e2e --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
})
