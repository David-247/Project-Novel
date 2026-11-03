import { getEngine } from './engine'

/**
 * Read-only engine status for tests and diagnostics (e2e backend, perf tests). Not for app code:
 * the store's `layout` slice is the model.
 */
export function getPaginationDebug() {
  const engine = getEngine()
  const snap = engine?.getSnapshot() ?? null
  return {
    /** An engine is mounted, has laid out at least once, and no pass is pending. */
    settled: !!engine && !!snap && !engine.pending,
    /** Run a pending pass now. */
    flush: () => engine?.flush(),
    /** Px reserved at the bottom of each page (bottom reservations). */
    reserved: snap ? snap.ranges.map((r) => r.reserved) : [],
    /** Number of measured line boxes in the stream. */
    lineCount: snap ? snap.lines.length : 0,
    /** Durations of the last pass (ms) and what it did. */
    lastPass: engine ? { ...engine.timings } : {},
    /** Line range [start, end) of each page. */
    lineRanges: snap ? snap.ranges.map((r) => [r.startLine, r.endLine] as const) : [],
  }
}
