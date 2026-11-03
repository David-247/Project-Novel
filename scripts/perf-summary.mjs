// Markdown table of the perf numbers in perf-results/*.json (written by e2e/perf.spec.ts).
// Appends to $GITHUB_STEP_SUMMARY in CI, otherwise prints to stdout. Never fails the job.
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2] ?? 'perf-results'
const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : []
const rows = []
for (const f of files) {
  try {
    const r = JSON.parse(readFileSync(join(dir, f), 'utf8'))
    const t = r.typing ?? {}
    rows.push(
      `| ${r.scenario ?? 'perf'} | ${r.browser} | ${r.platform} | ${t.medianMs ?? '–'} | ${t.p95Ms ?? '–'} | ${t.maxMs ?? '–'} | ` +
        `${r.replaceAllMs ?? '–'} | ${r.openMs ?? '–'} |`,
    )
  } catch (e) {
    rows.push(`| ${f} | unreadable: ${String(e).slice(0, 60)} | | | | | | |`)
  }
}
const md = [
  '### Performance (100,000-word manuscript)',
  '',
  rows.length
    ? [
        '| scenario | browser | OS | typing median ms (budget < 50) | typing p95 ms | typing max ms | Replace All ms (< 2000) | open ms |',
        '| --- | --- | --- | --- | --- | --- | --- | --- |',
        ...rows,
      ].join('\n')
    : `_No perf results found in ${dir}/._`,
  '',
].join('\n')

if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n')
else console.log(md)
