/**
 * One queue for every write to the open project folder (manual saves,
 * autosave snapshots, recovery cleanup), so they never overlap: an autosave
 * snapshot can never interleave with a manual save, and "delete recovery data
 * after a clean save" can never be undone by a snapshot already in flight.
 */
let tail: Promise<unknown> = Promise.resolve()

/** Run `fn` after every previously queued write has settled. */
export function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn)
  tail = run.catch(() => undefined)
  return run
}

/** Test-only. */
export function __resetWriteLockForTests(): void {
  tail = Promise.resolve()
}
