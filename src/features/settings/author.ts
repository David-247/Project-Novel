import { useStore } from '@/shared/store'
import { closeAuthorPrompt, isSettingsOpen, openAuthorPrompt } from './dialog-state'

export interface Author {
  /** Trimmed; '' when no name is known and the one-time question was dismissed. */
  name: string
  /** `#rrggbb`, or null for the automatic colour. */
  color: string | null
}

/** The author to attribute tracked changes and comments to (non-React). */
let lastAuthor: Author = { name: '', color: null }

/** The same object until the name or colour changes, so it is safe in dependency lists. */
function stableAuthor(name: string, color: string | null): Author {
  if (lastAuthor.name !== name || lastAuthor.color !== color) lastAuthor = { name, color }
  return lastAuthor
}

export function getAuthor(): Author {
  const p = useStore.getState().preferences
  return stableAuthor(p.authorName.trim(), p.authorColor)
}

/** Reactive `getAuthor()` (a stable reference between changes). */
export function useAuthor(): Author {
  const name = useStore((s) => s.preferences.authorName).trim()
  const color = useStore((s) => s.preferences.authorColor)
  return stableAuthor(name, color)
}

/** How long to wait for preferences to load before treating them as defaults. */
const LOAD_WAIT_MS = 2000

function whenLoaded(): Promise<void> {
  if (useStore.getState().preferences.loaded) return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      unsubscribe()
      resolve()
    }
    const unsubscribe = useStore.subscribe((s) => {
      if (s.preferences.loaded) done()
    })
    const timer = setTimeout(done, LOAD_WAIT_MS)
  })
}

let pendingPrompt: { promise: Promise<string>; settle: (name: string) => void } | null = null

/**
 * The author name for a tracked change or comment. When a name is known, it is returned at once.
 * When none can be determined (the OS gave none and the user set none), the one-time question is
 * shown and the answer returned; if the user dismisses it, '' is returned and the question is not
 * asked again (the name can still be set in Settings). Concurrent callers share one question.
 */
export async function ensureAuthorName(): Promise<string> {
  await whenLoaded()
  const known = getAuthor().name
  if (known) return known
  // The name field in Settings writes on every keystroke: an empty value mid-edit is not "no name".
  if (isSettingsOpen()) return ''
  if (pendingPrompt) return pendingPrompt.promise
  if (useStore.getState().preferences.authorPrompted) return ''
  let settle!: (name: string) => void
  const promise = new Promise<string>((resolve) => {
    settle = resolve
  })
  pendingPrompt = { promise, settle }
  openAuthorPrompt()
  return promise
}

/** The prompt was answered: `name` is saved; null = dismissed. Resolves the waiting callers. */
export function answerAuthorPrompt(name: string | null): void {
  const trimmed = name?.trim() ?? ''
  const actions = useStore.getState().preferencesActions
  if (trimmed) actions.set('authorName', trimmed)
  actions.set('authorPrompted', true)
  closeAuthorPrompt()
  pendingPrompt?.settle(trimmed)
  pendingPrompt = null
}
