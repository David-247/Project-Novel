import { expect, test } from '@playwright/test'
import { budget } from './budget'
import { buildPaginationFixture } from './fixtures/pagination-manuscript'
import { launch, waitForLayout } from './helpers'
import { report } from './perf-helpers'

/**
 * Export (Phase 4): building the manuscript IR (src/features/export/ir, docs/manuscript-ir.md) for the
 * 100,000-word fixture takes < 500 ms (median of 5 builds after a warm-up), measured in the page on the
 * open document: once clean, once with 2,000 pending tracked changes (resolved as accepted). The
 * build from the document's JSON (what a worker would do) is reported, not budgeted.
 * Numbers go to perf-results/perf-export-*.json (scripts/perf-summary.mjs, "Export").
 */

const RUNS = 5
const CHANGES = 2000

const DATE = '2026-11-01T10:00:00.000Z'
const mark = (type: 'insertion' | 'deletion', id: string) => ({ type, attrs: { id, author: 'Ann', date: DATE } })

/** The fixture with CHANGES pending changes: a deleted and an inserted word in the first CHANGES / 2 paragraphs. */
function withTrackedChanges(doc: { type: 'doc'; content: unknown[] }) {
  let n = 0
  const content = doc.content.map((block) => {
    const b = block as { type: string; content?: unknown[] }
    if (b.type !== 'paragraph' || n >= CHANGES) return block
    n += 2
    return { ...b, content: [...(b.content ?? []), { type: 'text', text: ' gone', marks: [mark('deletion', `d${n}`)] }, { type: 'text', text: ' new', marks: [mark('insertion', `i${n}`)] }] }
  })
  return { type: 'doc' as const, content }
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

test('100k-word manuscript: the export IR builds within budget', async ({ page }, testInfo) => {
  test.setTimeout(180_000)
  const fixture = buildPaginationFixture()
  expect(fixture.words).toBe(100_000)
  await launch(page)

  const measure = async (doc: unknown) => {
    await page.evaluate((d) => window.__nvE2E.setDoc(d), doc)
    // The build is measured on a quiet page, not during the opening layout.
    await waitForLayout(page)
    const r = await page.evaluate((runs) => window.__nvE2E.buildManuscriptTimes(runs), RUNS)
    expect(r).not.toBeNull()
    return { medianMs: median(r!.ms), maxMs: Math.max(...r!.ms), fromJsonMedianMs: median(r!.fromJsonMs), runs: r!.ms, chapters: r!.chapters, blocks: r!.blocks, trackedChanges: r!.trackedChanges }
  }

  const irBuild = await measure(fixture.doc)
  expect(irBuild.chapters).toBe(fixture.chapters)
  const irBuildTracked = await measure(withTrackedChanges(fixture.doc))
  expect(irBuildTracked.trackedChanges).toBe(CHANGES)

  await report(testInfo, 'perf-export', { irBuild, irBuildTracked })
  budget(testInfo, 'manuscript IR build, median ms', irBuild.medianMs, 500)
  budget(testInfo, 'manuscript IR build with 2,000 pending changes, median ms', irBuildTracked.medianMs, 500)
})
