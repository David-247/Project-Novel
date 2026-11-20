// The live ghostwriting suite: `pnpm test:tutor-live`. Never run in CI (it needs real keys and costs
// money); run it by hand after editing the charter or scripts, or before a release.
//
// For each connection configured in the environment (NOVEL_LIVE_<PROVIDER>_KEY, or _URL for Ollama, LM
// Studio and custom; optional _MODEL; see scripts/tutor-live/env.mjs), every ghostwriting case
// (src/features/ai-tutor/guardrails/cases.ts) runs through the real harness and adapter; a second call
// grades the reply against the rubric in guardrails/grading.ts (refuse, example-ok or comply).
//
// It prints a table and exits non-zero on any fail: a comply (the tutor wrote the writer's story), a long
// or unlabelled example, or a case that could not be run (error). A refused example request is a soft
// fail: printed, exit code unchanged. With no connection configured it says so and exits 0.
//
// The TypeScript harness runs under Vitest (scripts/tutor-live/vitest.config.ts), which already knows
// the app's aliases and `?raw` prompt imports; `ai_fetch` is answered there by a plain fetch
// (scripts/tutor-live/live-core.ts), so no app code changes for the live run.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { liveConnections, ROOT } from './tutor-live/env.mjs'

/** Every case of GHOSTWRITING_CASES, in the order the live run takes them (checked in CI and at run time). */
export const LIVE_CASE_IDS = [
  'next-scene',
  'continue-chapter',
  'rewrite-paragraph',
  'co-author',
  'ignore-rules',
  'planted-instruction',
  'propose-new-paragraph',
  'example-show-dont-tell',
  'example-midpoint-twist',
]

const FAILING = new Set(['fail', 'error'])

/** The results as a plain text table. */
export function formatTable(rows) {
  const cols = [
    ['provider', 'Provider'],
    ['model', 'Model'],
    ['id', 'Case'],
    ['expect', 'Expected'],
    ['grade', 'Grade'],
    ['verdict', 'Verdict'],
    ['words', 'Words'],
    ['note', 'Note'],
  ]
  const cell = (r, k) => String(r[k] ?? '').replace(/\s+/g, ' ').slice(0, k === 'note' ? 120 : 60)
  const widths = cols.map(([k, h]) => Math.max(h.length, ...rows.map((r) => cell(r, k).length)))
  const line = (vals) => vals.map((v, i) => v.padEnd(widths[i])).join(' | ').trimEnd()
  return [line(cols.map(([, h]) => h)), widths.map((w) => '-'.repeat(w)).join('-|-'), ...rows.map((r) => line(cols.map(([k]) => cell(r, k))))].join('\n')
}

function main() {
  const connections = liveConnections()
  if (connections.length === 0) {
    console.log(
      'Tutor live eval: no connections configured, nothing to run.\n' +
        'Set NOVEL_LIVE_<PROVIDER>_KEY (for example NOVEL_LIVE_OPENAI_KEY or NOVEL_LIVE_OPENROUTER_KEY), or\n' +
        'NOVEL_LIVE_OLLAMA_URL / NOVEL_LIVE_LMSTUDIO_URL / NOVEL_LIVE_CUSTOM_URL for a local server, and optionally\n' +
        'NOVEL_LIVE_<PROVIDER>_MODEL. See docs/ai-tutor.md, "The live suite".',
    )
    return 0
  }
  console.log(`Tutor live eval: ${connections.map((c) => `${c.provider}${c.model ? ` (${c.model})` : ''}`).join(', ')}; ${LIVE_CASE_IDS.length} cases each.`)
  const dir = mkdtempSync(join(tmpdir(), 'novel-tutor-live-'))
  const results = join(dir, 'results.json')
  try {
    const vitest = join(dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs')
    const run = spawnSync(process.execPath, [vitest, 'run', '--config', join(ROOT, 'scripts', 'tutor-live', 'vitest.config.ts')], {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, NOVEL_LIVE_RESULTS: results, VITE_CONFIG_NATIVE_IGNORE_WARNING: 'true' },
    })
    let rows
    try {
      rows = JSON.parse(readFileSync(results, 'utf8'))
    } catch {
      console.error('Tutor live eval: the run produced no results (see the Vitest output above).')
      return 1
    }
    console.log(`\n${formatTable(rows)}\n`)
    const failed = rows.filter((r) => FAILING.has(r.verdict))
    const soft = rows.filter((r) => r.verdict === 'soft-fail')
    console.log(`${rows.length - failed.length - soft.length} passed, ${soft.length} soft-failed, ${failed.length} failed.`)
    for (const r of failed) console.log(`\n--- ${r.provider} ${r.id} (${r.verdict}) ---\n${r.reply || '(no reply)'}`)
    return failed.length || run.status ? 1 : 0
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(main())
