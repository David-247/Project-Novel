import { invoke } from '@tauri-apps/api/core'
import {
  parsePreferences,
  serializePreferences,
  setSystemAuthorName,
  useStore,
  type Preferences,
} from '@/shared/store'

/** Command names (src-tauri/src/preferences.rs). */
export const PREFERENCE_COMMANDS = {
  read: 'preferences_read',
  write: 'preferences_write',
  defaultAuthor: 'preferences_default_author',
} as const

/** Wait this long after the last change before writing (a burst of typing is one write). */
export const WRITE_DEBOUNCE_MS = 300

const actions = () => useStore.getState().preferencesActions

async function osAuthorName(): Promise<string> {
  try {
    const name = await invoke<string>(PREFERENCE_COMMANDS.defaultAuthor)
    return typeof name === 'string' ? name.trim() : ''
  } catch {
    return ''
  }
}

/**
 * Read preferences.json into the store. Never throws: a missing, damaged or unreadable file (or no
 * Tauri backend at all) leaves the defaults, the app starts normally, and the next write repairs the
 * file. The author name defaults to the OS user's name when the file has none.
 */
export async function loadPreferences(): Promise<void> {
  let text: string | null = null
  try {
    text = (await invoke<string | null>(PREFERENCE_COMMANDS.read)) ?? null
  } catch {
    // An I/O error is treated like a missing file: defaults in memory; the next change rewrites it.
  }
  const parsed = parsePreferences(text)
  const system = await osAuthorName()
  setSystemAuthorName(system)
  const values = { ...parsed.values }
  if (parsed.authorNameMissing) values.authorName = system
  actions().load({ ...values, extra: parsed.extra })
}

let timer: ReturnType<typeof setTimeout> | null = null
let writing: Promise<void> = Promise.resolve()
let pending = false

/** Write the current preferences now (cancelling any scheduled write). Resolves when written. */
export function flushPreferences(): Promise<void> {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
  if (!pending) return writing
  pending = false
  const p: Preferences = useStore.getState().preferences
  const text = serializePreferences(p)
  writing = writing
    .then(() => invoke<void>(PREFERENCE_COMMANDS.write, { contents: text }))
    .catch((e) => console.warn('Saving preferences failed:', e))
  return writing
}

function schedule(): void {
  pending = true
  if (timer !== null) clearTimeout(timer)
  timer = setTimeout(() => void flushPreferences(), WRITE_DEBOUNCE_MS)
}

/**
 * Write preferences (debounced) whenever they change after the initial load. Returns the stop
 * function. The load itself never triggers a write, so a damaged file is repaired by the first real change.
 */
export function startPreferencesWriter(): () => void {
  let last = useStore.getState().preferences
  const unsubscribe = useStore.subscribe((s) => {
    const next = s.preferences
    if (next === last) return
    const wasLoaded = last.loaded
    last = next
    if (wasLoaded && next.loaded) schedule()
  })
  const onHide = () => void flushPreferences()
  window.addEventListener('pagehide', onHide)
  return () => {
    unsubscribe()
    window.removeEventListener('pagehide', onHide)
    void flushPreferences()
  }
}
