// Vitest config for the live ghostwriting suite only (scripts/tutor-live-eval.mjs starts it). It is the
// app's config (aliases, `?raw` prompts, jsdom) with just the live eval as its test file.
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'
import base from '../../vite.config'

export default defineConfig({
  ...base,
  root: fileURLToPath(new URL('../..', import.meta.url)),
  test: {
    ...base.test,
    include: ['scripts/tutor-live/live.eval.ts'],
    testTimeout: 60 * 60 * 1000,
    // One connection at a time, one case at a time: no provider is hit in parallel.
    fileParallelism: false,
  },
})
