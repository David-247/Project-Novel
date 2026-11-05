import { registerSideFile, type ProjectSideFile } from '@/features/storage'
import { useStore } from '@/shared/store'
import { flushLiveVersions } from './commands'
import { parseRewritesFile, REWRITES_FILE, serializeRewritesFile } from './model'

/**
 * rewrites.json as a project side file (storage slice): read on open, written in one batch with the
 * manuscript on every save, snapshotted by autosave (crash recovery), guarded when damaged or newer.
 * Unknown keys (top level, re-writes, versions) and entries this version cannot read are written
 * back unchanged. The revision being typed is copied into the store first, so a save or a snapshot
 * always holds the latest keystroke.
 */
let fileExtra: Record<string, unknown> = {}
let unreadable: unknown[] = []

export const rewritesSideFile: ProjectSideFile = {
  name: REWRITES_FILE,
  load(data) {
    const parsed = parseRewritesFile(data)
    fileExtra = parsed.extra
    unreadable = parsed.unreadable
    useStore.getState().rewriteActions.loaded(parsed.rewrites)
    return parsed.newer !== undefined ? { newer: parsed.newer } : undefined
  },
  serialize() {
    flushLiveVersions()
    const rewrites = useStore.getState().rewrite.rewrites
    return {
      data: serializeRewritesFile({ rewrites: [...rewrites], extra: fileExtra, unreadable }),
      empty: rewrites.length === 0 && unreadable.length === 0 && Object.keys(fileExtra).length === 0,
    }
  },
  getVersion: () => useStore.getState().rewrite.version,
}

/** Register rewrites.json with the storage slice (once, at app start). Returns unregister. */
export function registerRewritesSideFile(): () => void {
  return registerSideFile(rewritesSideFile)
}

/** Test-only. */
export function __resetRewritesFileForTests(): void {
  fileExtra = {}
  unreadable = []
}
