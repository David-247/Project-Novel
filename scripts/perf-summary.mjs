// Markdown tables of the perf numbers in perf-results/*.json (written by e2e/perf.spec.ts,
// e2e/pagination-perf.spec.ts, e2e/perf-export.spec.ts, e2e/outline-perf.spec.ts and, for the PDF
// render, src/features/export/pdf/pdf.sidecar.test.ts). Budgeted measures and reported-only ones
// (budget column "–") both go in. Appends to $GITHUB_STEP_SUMMARY in CI, otherwise prints to stdout.
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
    add(`${r.scenario}: in the open re-write`, r.typingRevision, 'typingRevision')
    add(`${r.scenario}: Enter / Backspace`, r.enterBackspace)
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
        md.push(`| ${r.scenario} | ${pair(r)} | ${cell(r, r.restyleMs, 100, 'restyleMs')} | ${cell(r, r.repaginatedMs, 1000)} | ${cell(r, r.allDrawnMs, 3000)} | ${v(r.chaptersRestyled)} |`)
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

  // Phase 3 (revision tools): one row per measure, with its budget (e2e/perf.spec.ts, comments-perf,
  // rewrite-perf, phase3-perf).
  const rows = []
  for (const r of results) {
    const row = (measure, n, limit, key) => n !== undefined && n !== null && rows.push(`| ${r.scenario} | ${measure} | ${pair(r)} | ${cell(r, n, limit, key)} | ${limit} |`)
    const m = r.markupSwitch
    if (m) {
      row('markup view switch to No Markup: reflow complete', m.toNoMarkupMs, 1000)
      row('markup view switch to Original: reflow complete', m.toOriginalMs, 1000)
      row('markup view switch to All Markup: reflow complete', m.toAllMarkupMs, 1000)
      row('markup view switch: all blocks drawn (worst)', m.allDrawnWorstMs, 3000)
    }
    if (r.replaceAll && typeof r.replaceAll === 'object') row('Replace All with recording on', r.replaceAll.ms, 2000)
    if (r.acceptAll) row('Accept All of 2,000 changes (incl. repagination)', r.acceptAll.ms, 2000)
    if (r.rejectAll) row('Reject All of 2,000 changes (incl. repagination)', r.rejectAll.ms, 2000)
    if (r.maxPanelCommitMs !== undefined) row('comment panel re-layout after a reflow (worst trim)', r.maxPanelCommitMs, 100)
    if (Array.isArray(r.open)) r.open.forEach((o, i) => row(`open re-write #${i + 1}`, o.openMs, 300))
    else if (r.open && typeof r.open === 'object') row('open re-write', r.open.openMs, 300)
    if (r.keep) {
      row('Keep This Version: reflow complete', r.keep.reflowMs, 1000)
      row('Keep This Version: all blocks drawn', r.keep.allDrawnMs, 3000)
    }
    for (const [key, label] of [
      ['selectAllBold', 'Select All + Bold'],
      ['selectAllBoldTracked', 'Select All + Bold, recording on'],
      ['acceptAllFormatting', 'Accept All of the formatting changes'],
    ]) {
      if (!r[key]) continue
      row(`${label}: reflow complete`, r[key].ms, 1000)
      row(`${label}: all blocks drawn`, r[key].allDrawnMs, 3000)
    }
  }
  if (rows.length) {
    md.push('#### Revision tools (track changes, comments, re-write)', '')
    md.push('| scenario | measure | engine / OS | ms | budget ms |', '| --- | --- | --- | --- | --- |', ...rows, '')
  }

  // Phase 4 (export): the manuscript IR build (e2e/perf-export.spec.ts).
  const exportRows = []
  for (const r of results) {
    const row = (measure, n, limit) => n !== undefined && n !== null && exportRows.push(`| ${r.scenario} | ${measure} | ${pair(r)} | ${cell(r, n, limit)} | ${limit ?? '–'} |`)
    if (r.irBuild) {
      row('manuscript IR build (median)', r.irBuild.medianMs, 500)
      row('manuscript IR build (slowest run; reported)', r.irBuild.maxMs)
      row('manuscript IR from the stored JSON, no editor (median; reported)', r.irBuild.fromJsonMedianMs)
    }
    if (r.irBuildTracked) row('manuscript IR build, 2,000 pending changes (median)', r.irBuildTracked.medianMs, 500)
    // The PDF render (src/features/export/pdf/pdf.sidecar.test.ts, the Typst sidecar, no browser):
    // blocking on Windows, recorded on macOS (decisions 1cedc290, f040009b).
    if (r.pdfRender) {
      const { ms, pages } = r.pdfRender
      const miss = ms >= 15000 ? ` (${r.platform === 'win32' ? 'MISS' : 'miss, warning'})` : ''
      exportRows.push(`| ${r.scenario} | PDF render, Typst sidecar (${v(pages)} pages) | typst / ${r.platform}${r.platform === 'win32' ? ' (blocking)' : ''} | ${miss ? `**${ms}**${miss}` : v(ms)} | 15000 |`)
    }
    if (r.docxExport) {
      row('DOCX export, 100k words: IR + render in the worker (median)', r.docxExport.medianMs, 5000)
      row('DOCX export (slowest run; reported)', r.docxExport.maxMs)
      row('DOCX export: animation frames painted during the last run (reported)', r.docxExport.framesDuringLastRun)
    }
    if (r.docxExportClassic) {
      row('DOCX export, 100k words, Classic preset (median)', r.docxExportClassic.medianMs, 5000)
      row('DOCX export, Classic preset (slowest run; reported)', r.docxExportClassic.maxMs)
    }
  }
  if (exportRows.length) {
    md.push('#### Export', '')
    md.push('| scenario | measure | engine / OS | ms | budget ms |', '| --- | --- | --- | --- | --- |', ...exportRows, '')
  }

  // Phase 4: live word counts (e2e/perf.spec.ts). Typing with the counts on is in the typing table
  // (blocking on Windows Chromium like plain typing); the count's catch-up is reported, not a budget.
  const counts = results.filter((r) => r.wordCount && typeof r.wordCount === 'object')
  if (counts.length) {
    md.push('#### Live word count (status bar update after typing; reported, no budget)', '')
    md.push('| scenario | engine / OS | one keystroke to count shown ms | after typing, caught up ms |', '| --- | --- | --- | --- |')
    for (const r of counts) md.push(`| ${r.scenario} | ${pair(r)} | ${v(r.wordCount.updateMs)} | ${v(r.wordCount.caughtUpMs)} |`)
    md.push('')
  }

  // Phase 4: the navigation pane (e2e/outline-perf.spec.ts). Typing with the pane open is in the typing
  // table; here, the pane catching up after typing (reported) and after a trim reflow (< 1000 ms).
  const paneRows = []
  for (const r of results) {
    if (r.outline && r.outline.caughtUpMs !== undefined)
      paneRows.push(`| ${r.scenario} | counts caught up after typing (reported) | ${pair(r)} | ${v(r.outline.caughtUpMs)} | – |`)
    if (r.outline && r.outline.lastBuildMs !== undefined)
      paneRows.push(`| ${r.scenario} | last outline build (reported) | ${pair(r)} | ${v(+Number(r.outline.lastBuildMs).toFixed(1))} | – |`)
    const o = r.outlineAfterReflow
    if (o && Array.isArray(o.runs)) {
      for (const x of o.runs)
        paneRows.push(`| ${r.scenario} | ${x.trim}: new pages shown after the trim change (reflow ${v(x.reflowMs)}, then ${v(x.lagMs)}) | ${pair(r)} | ${cell(r, x.outlineMs, 1000)} | 1000 |`)
    }
  }
  if (paneRows.length) {
    md.push('#### Navigation pane', '')
    md.push('| scenario | measure | engine / OS | ms | budget ms |', '| --- | --- | --- | --- | --- |', ...paneRows, '')
  }

  // Phase 5: spell check (e2e/spellcheck-perf.spec.ts). Typing with it on is in the typing table
  // (blocking on Windows Chromium like plain typing); here, a typed misspelling's underline after the
  // pause and the engine calls made while typing and scrolling (reported, no budget).
  const spell = results.filter((r) => r.spellcheck && typeof r.spellcheck === 'object')
  if (spell.length) {
    md.push('#### Spell check (reported, no budget)', '')
    md.push('| scenario | engine / OS | last keystroke to underline ms | engine calls | most blocks in one call | blocks checked |', '| --- | --- | --- | --- | --- | --- |')
    for (const r of spell) md.push(`| ${r.scenario} | ${pair(r)} | ${v(r.spellcheck.underlineMs)} | ${v(r.spellcheck.engineCalls)} | ${v(r.spellcheck.maxBlocksPerCall)} | ${v(r.spellcheck.blocksChecked)} |`)
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
