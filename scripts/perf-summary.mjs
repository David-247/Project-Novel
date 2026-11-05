// Markdown tables of the perf numbers in perf-results/*.json (written by e2e/perf.spec.ts and
// e2e/pagination-perf.spec.ts). Appends to $GITHUB_STEP_SUMMARY in CI, otherwise prints to stdout.
// Never fails the job: the budgets are asserted by the tests. In CI only Windows Chromium blocks; every
// other pair, macOS WebKit included (free shared runner), reports a miss as a warning (decisions
// afbe3475, f040009b).
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const SHIPPING = new Set(['webkit|darwin', 'chromium|win32'])
const engineOf = (browser) => String(browser ?? '').replace(/^perf-/, '')
export const isShipping = (r) => SHIPPING.has(`${engineOf(r.browser)}|${r.platform}`)
/** Whether a miss failed the CI job: a shipping pair, except macOS (decision f040009b). */
export const isBlocking = (r) => isShipping(r) && r.platform !== 'darwin'
const v = (n) => (n === undefined || n === null ? '–' : String(n))
/** A measure the result lists as CI-advisory (e2e/budget.ts `ciAdvisory`): reported, never blocking in CI. */
export const isAdvisory = (r, key) => Array.isArray(r.ciAdvisory) && r.ciAdvisory.includes(key)
/**
 * "12.3" plus a miss marker against `limit` (MISS where it blocks CI, warning elsewhere; a CI-advisory
 * measure, named by its result key, is marked report-only).
 */
const cell = (r, n, limit, key) => {
  if (n === undefined || n === null) return '–'
  if (limit === undefined || n < limit) return String(n)
  if (key && isAdvisory(r, key)) return `**${n}** (miss, CI-advisory: not blocking)`
  return `**${n}** (${isBlocking(r) ? 'MISS' : 'miss, warning'})`
}
const pair = (r) => `${engineOf(r.browser)} / ${r.platform}${isShipping(r) ? ' (shipping)' : ''}`

export function loadResults(dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json') && !x.startsWith('pagination-fixture')).sort()) {
    try {
      out.push({ file: f, ...JSON.parse(readFileSync(join(dir, f), 'utf8')) })
    } catch (e) {
      out.push({ file: f, scenario: f, error: String(e).slice(0, 80) })
    }
  }
  return out
}

export function toMarkdown(results, dir = 'perf-results') {
  const md = ['### Performance (100,000-word manuscript)', '']
  if (!results.length) return [...md, `_No perf results found in ${dir}/._`, ''].join('\n')
  md.push('Budgets block CI on Windows Chromium only; elsewhere, macOS WebKit included (free shared runner), a miss is a warning.', '')

  const typing = []
  for (const r of results) {
    const add = (label, t, key) => t && typing.push(`| ${label} | ${pair(r)} | ${cell(r, t.medianMs, 50, key)} | ${v(t.p95Ms)} | ${v(t.maxMs)} | ${v(r.openMs)} |`)
    add(r.scenario, r.typing, 'typing')
    add(`${r.scenario}: No Markup`, r.typingNoMarkup, 'typingNoMarkup')
    add(`${r.scenario}: Simple Markup`, r.typingSimpleMarkup, 'typingSimpleMarkup')
    add(`${r.scenario}: end of line`, r.endOfLine)
    add(`${r.scenario}: split paragraph`, r.splitParagraph)
  }
  if (typing.length) {
    md.push('#### Typing latency (keydown to paint)', '')
    md.push('| scenario | engine / OS | median ms (< 50) | p95 ms | max ms | open ms |', '| --- | --- | --- | --- | --- | --- |', ...typing, '')
  }

  const trims = results.filter((r) => Array.isArray(r.reflows))
  if (trims.length) {
    md.push('#### Trim size reflow (reflow complete < 1000 ms; all blocks drawn < 3000 ms)', '')
    md.push('| scenario | engine / OS | max reflow ms | max all drawn ms | per trim: reflow / all drawn ms (pages) |', '| --- | --- | --- | --- | --- |')
    for (const r of trims) {
      const per = r.reflows.map((x) => `${x.trim} ${x.ms} / ${x.allDrawnMs} (${x.pages})`).join('; ')
      md.push(`| ${r.scenario} | ${pair(r)} | ${cell(r, r.maxReflowMs, 1000)} | ${cell(r, r.maxAllDrawnMs, 3000)} | ${per} |`)
    }
    md.push('')
  }

  // The perf spec measures the sheet swap and the repagination separately; the acceptance scenario
  // (e2e/phase2-acceptance.spec.ts) times the same edit through the Modify style dialog, end to end.
  const styles = results.filter((r) => r.restyleMs !== undefined || r.chapterStyleEdit)
  if (styles.length) {
    md.push('#### Chapter Title style edit (style sheet swap < 100 ms; reflow complete < 1000 ms)', '')
    md.push('| scenario | engine / OS | sheet swap ms | reflow complete ms | all drawn ms | chapters restyled |', '| --- | --- | --- | --- | --- | --- |')
    for (const r of styles) {
      if (r.restyleMs !== undefined) {
        md.push(`| ${r.scenario} | ${pair(r)} | ${cell(r, r.restyleMs, 100)} | ${cell(r, r.repaginatedMs, 1000)} | ${cell(r, r.allDrawnMs, 3000)} | ${v(r.chaptersRestyled)} |`)
      } else {
        const e = r.chapterStyleEdit
        md.push(`| ${r.scenario} | ${pair(r)} | – | ${cell(r, e.ms, 1000)} | ${cell(r, e.allDrawnMs, 3000)} | – |`)
      }
    }
    md.push('')
  }

  const turns = results.filter((r) => r.turnMedianMs !== undefined)
  if (turns.length) {
    md.push('#### Book mode page turn (fully drawn spread < 100 ms)', '')
    md.push('| scenario | engine / OS | median ms | max ms | max during a trim reflow ms |', '| --- | --- | --- | --- | --- |')
    for (const r of turns)
      md.push(`| ${r.scenario} | ${pair(r)} | ${v(r.turnMedianMs)} | ${cell(r, r.turnMaxMs, 100)} | ${cell(r, r.duringReflowMaxMs, 100, 'duringReflowMaxMs')} |`)
    md.push('')
  }

  const replace = results.filter((r) => r.replaceAllMs !== undefined)
  if (replace.length) {
    md.push('#### Replace All (10,000 occurrences, < 2000 ms)', '')
    md.push('| engine / OS | Replace All ms |', '| --- | --- |')
    for (const r of replace) md.push(`| ${pair(r)} | ${cell(r, r.replaceAllMs, 2000)} |`)
    md.push('')
  }

  const broken = results.filter((r) => r.error)
  for (const r of broken) md.push(`- ${r.file}: unreadable (${r.error})`)
  return md.join('\n') + '\n'
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const dir = process.argv[2] ?? 'perf-results'
  const md = toMarkdown(loadResults(dir), dir)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n')
  else console.log(md)
}
