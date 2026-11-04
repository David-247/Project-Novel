// Cross-engine page-break comparison (Phase 2 acceptance). Reads the JSONs that
// e2e/pagination-fixture.spec.ts writes (perf-results/pagination-fixture-<browser>-<platform>.json),
// from any folder depth (CI downloads one artifact folder per OS), compares every pair of runs,
// and fails when the logged tolerance is exceeded:
//   - total page count: |a - b| <= max(2 pages, 1 % of the larger count)  (decision c945d094)
//   - chapter opening page index: ±1 when chapters start on the next page ('page'),
//     ±2 when they start on a right-hand page ('recto')                  (decision 75522017)
// The shipping pair (WebKit on macOS ~ WKWebView, Chromium on Windows ~ WebView2) comes first.
// Every pair is blocking (decision afbe3475: the tolerance is blocking on all pairs).
//
//   node scripts/compare-pagination.mjs [dir=perf-results] [--require webkit-darwin,chromium-win32] [--out file.json]
//
// Writes a markdown table to $GITHUB_STEP_SUMMARY (stdout otherwise); exit code 1 on failure.
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const SHIPPING = ['webkit-darwin', 'chromium-win32']
const ORDER = ['webkit-darwin', 'chromium-win32', 'chromium-darwin', 'webkit-win32']

export const runKey = (r) => `${r.browser}-${r.platform}`

/** Allowed total page difference: max(2 pages, 1 % of the larger count). */
export const totalLimit = (a, b) => Math.max(2, 0.01 * Math.max(a, b))

/** Allowed chapter opening drift: ±1 page, ±2 when chapters open on a right-hand page. */
export const openingLimit = (mode) => (mode === 'recto' ? 2 : 1)

const fmt = (n) => (n === null || n === undefined ? '–' : Number.isInteger(n) ? String(n) : n.toFixed(2))

/** Compare two fixture runs, row by row (mode x trim). */
export function compareRuns(a, b) {
  const key = (r) => `${r.mode}|${r.trim}`
  const inB = new Map(b.results.map((r) => [key(r), r]))
  const seen = new Set()
  const rows = []
  const both = [...a.results, ...b.results.filter((r) => !a.results.some((x) => key(x) === key(r)))]
  for (const r of both) {
    const k = key(r)
    if (seen.has(k)) continue
    seen.add(k)
    const ra = a.results.find((x) => key(x) === k)
    const rb = inB.get(k)
    const limitOpen = openingLimit(r.mode)
    const row = {
      mode: r.mode,
      trim: r.trim,
      pagesA: ra?.pageCount ?? null,
      pagesB: rb?.pageCount ?? null,
      totalDiff: null,
      totalLimit: null,
      maxOpeningDrift: null,
      openingLimit: limitOpen,
      ok: true,
      problems: [],
    }
    if (!ra || !rb) {
      row.ok = false
      row.problems.push(`missing in ${!ra ? runKey(a) : runKey(b)}`)
      rows.push(row)
      continue
    }
    // Every fixture has chapters: an empty list means the run measured nothing, never a pass.
    const empty = [ra, rb].map((x, i) => (x.chapterOpenings.length === 0 ? runKey(i === 0 ? a : b) : null)).filter(Boolean)
    if (empty.length) row.problems.push(`no chapter openings in ${empty.join(', ')}`)
    row.totalDiff = Math.abs(ra.pageCount - rb.pageCount)
    row.totalLimit = totalLimit(ra.pageCount, rb.pageCount)
    if (row.totalDiff > row.totalLimit) row.problems.push(`total pages differ by ${row.totalDiff} (limit ${fmt(row.totalLimit)})`)
    if (ra.chapterOpenings.length !== rb.chapterOpenings.length) {
      row.problems.push(`${ra.chapterOpenings.length} vs ${rb.chapterOpenings.length} chapter openings`)
    }
    let drift = 0
    const n = Math.min(ra.chapterOpenings.length, rb.chapterOpenings.length)
    for (let i = 0; i < n; i++) {
      const d = Math.abs(ra.chapterOpenings[i] - rb.chapterOpenings[i])
      drift = Math.max(drift, d)
      if (d > limitOpen) row.problems.push(`chapter ${i + 1} opens on page ${ra.chapterOpenings[i]} vs ${rb.chapterOpenings[i]} (limit ±${limitOpen})`)
    }
    row.maxOpeningDrift = drift
    row.ok = row.problems.length === 0
    rows.push(row)
  }
  const ka = runKey(a)
  const kb = runKey(b)
  return { a: ka, b: kb, shipping: SHIPPING.includes(ka) && SHIPPING.includes(kb) && ka !== kb, ok: rows.length > 0 && rows.every((r) => r.ok), rows }
}

const rank = (k) => (ORDER.includes(k) ? ORDER.indexOf(k) : ORDER.length)

/** Every pair of runs (shipping pair first); `require` names runs that must be present. */
export function compareAll(runs, opts = {}) {
  const sorted = [...runs].sort((x, y) => rank(runKey(x)) - rank(runKey(y)) || runKey(x).localeCompare(runKey(y)))
  const problems = []
  for (const k of opts.require ?? []) if (!sorted.some((r) => runKey(r) === k)) problems.push(`required run ${k} not found`)
  if (sorted.length < 2) problems.push(`need at least two runs to compare, found ${sorted.length}`)
  const pairs = []
  for (let i = 0; i < sorted.length; i++) for (let j = i + 1; j < sorted.length; j++) pairs.push(compareRuns(sorted[i], sorted[j]))
  pairs.sort((p, q) => Number(q.shipping) - Number(p.shipping))
  return { ok: problems.length === 0 && pairs.every((p) => p.ok), pairs, problems }
}

/** Every pagination-fixture-*.json under `dir` (any depth). */
export function loadRuns(dir) {
  const out = []
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (/^pagination-fixture-.*\.json$/.test(name)) out.push(JSON.parse(readFileSync(p, 'utf8')))
    }
  }
  if (existsSync(dir)) walk(dir)
  return out
}

export function toMarkdown(report) {
  const lines = ['### Cross-engine page breaks (pagination fixture, bundled OFL font)', '']
  lines.push(
    'Tolerance: total pages differ by at most max(2, 1 %); chapter openings by at most 1 page (`page`) or 2 pages (`recto`).',
    '',
    `**Result: ${report.ok ? 'PASS' : 'FAIL'}**`,
    '',
  )
  for (const p of report.problems) lines.push(`- ${p}`)
  if (report.problems.length) lines.push('')
  // One line per pair (rows within tolerance, the largest differences), then a table of its failing rows only.
  const max = (xs) => (xs.length ? Math.max(...xs) : null)
  for (const pair of report.pairs) {
    const passing = pair.rows.filter((r) => r.ok)
    const failing = pair.rows.filter((r) => !r.ok)
    const maxTotal = max(pair.rows.map((r) => r.totalDiff).filter((n) => n !== null))
    const maxDrift = max(pair.rows.map((r) => r.maxOpeningDrift).filter((n) => n !== null))
    lines.push(
      `- ${pair.a} vs ${pair.b}${pair.shipping ? ' (shipping pair)' : ''}: ${pair.ok ? 'pass' : 'FAIL'}, ` +
        `${passing.length} of ${pair.rows.length} rows within tolerance (max total diff ${fmt(maxTotal)}, max opening drift ${fmt(maxDrift)})`,
    )
    if (!failing.length) continue
    lines.push('', `| mode | trim | pages ${pair.a} | pages ${pair.b} | total diff / limit | max opening drift / limit | status |`)
    lines.push('| --- | --- | --- | --- | --- | --- | --- |')
    for (const r of failing) {
      lines.push(
        `| ${r.mode} | ${r.trim} | ${fmt(r.pagesA)} | ${fmt(r.pagesB)} | ${fmt(r.totalDiff)} / ${fmt(r.totalLimit)} | ` +
          `${fmt(r.maxOpeningDrift)} / ${r.openingLimit} | FAIL: ${r.problems.join('; ')} |`,
      )
    }
    lines.push('')
  }
  lines.push('')
  return lines.join('\n')
}

function main(argv) {
  const args = [...argv]
  const opt = (name) => {
    const i = args.indexOf(name)
    if (i < 0) return undefined
    const [, v] = args.splice(i, 2)
    return v
  }
  const require = opt('--require')?.split(',').filter(Boolean) ?? []
  const out = opt('--out')
  const dir = args[0] ?? 'perf-results'
  const runs = loadRuns(dir)
  const report = compareAll(runs, { require })
  const md = toMarkdown(report)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n')
  console.log(md)
  if (out) writeFileSync(out, JSON.stringify({ runs: runs.map(runKey), ...report }, null, 2))
  if (!report.ok) {
    console.error('cross-engine page-break tolerance exceeded (see the table above)')
    process.exitCode = 1
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2))
