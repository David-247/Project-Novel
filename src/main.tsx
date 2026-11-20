import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './index.css'

async function boot() {
  // E2E builds only (`vite build --mode e2e`): a fake Tauri backend for Playwright.
  // MODE is replaced at build time, so production builds drop this import entirely.
  if (import.meta.env.MODE === 'e2e') {
    const { installE2EBackend } = await import('./test-utils/e2e-backend')
    await installE2EBackend()
  }
  // Dev server only (`pnpm tauri dev`): the AI tutor spike, `window.__tutorSpike()` (removed in
  // Phase 5 Task 9). DEV is false in every build, so bundles drop this import.
  if (import.meta.env.DEV) void import('./features/ai-tutor/spike').then((m) => m.installTutorSpike())
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

void boot()
