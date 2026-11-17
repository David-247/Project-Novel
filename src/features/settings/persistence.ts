import { invoke } from '@tauri-apps/api/core'
import {
  defaultPreferenceValues,
  parsePreferences,
  serializePreferences,
  setSystemAuthorName,
  useStore,
  type Preferences,
  type PreferenceValues,
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

type Values = Partial<PreferenceValues>

/** The preference values only (no `extra`, no `loaded`). */
function valuesOf(p: Preferences): PreferenceValues {
  const { extra: _extra, loaded: _loaded, ...values } = p
  return values
}

/** The values that differ between two states of the store: the user's changes in between. */
function changesBetween(from: Preferences, to: Preferences): Values {
  const a = valuesOf(from)
  const b = valuesOf(to)
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(b) as (keyof PreferenceValues)[]) if (a[k] !== b[k]) out[k] = b[k]
  return out as Values
}

/** What `loadPreferences` put into the store when the file could not be read (an I/O error), else null. */
let unreadBase: Preferences | null = null

/** The file's text, null (missing, or damaged: Rust says so), or 'error' (it could not be read). */
async function readFile(): Promise<string | null | 'error'> {
  try {
    return (await invoke<string | null>(PREFERENCE_COMMANDS.read)) ?? null
  } catch (e) {
    console.warn('Reading preferences failed:', e)
    return 'error'
  }
}

/** The file's values (the author name defaulting to `system`) and its unknown keys. */
function fromFile(text: string | null, system: string): Values & { extra: Record<string, unknown> } {
  const parsed = parsePreferences(text)
  const values = { ...parsed.values }
  if (parsed.authorNameMissing) values.authorName = system
  return { ...values, extra: parsed.extra }
}

/**
 * Read preferences.json into the store. Never throws: a missing, damaged or unreadable file (or no
 * Tauri backend at all) leaves the defaults and the app starts normally. The next write repairs a
 * missing or damaged file; a file that could not be read (locked by another program) is read again
 * before the first write, so it is never replaced by defaults. The author name defaults to the OS
 * user's name when the file has none. A change made before the file loaded is kept over it.
 */
export async function loadPreferences(): Promise<void> {
  const text = await readFile()
  const system = await osAuthorName()
  setSystemAuthorName(system)
  // Changes made before the load (the store still holds the defaults then): kept over the file.
  const now = useStore.getState().preferences
  const early = now.loaded ? {} : changesBetween({ ...defaultPreferenceValues(), extra: {}, loaded: false }, now)
  actions().load({ ...fromFile(text === 'error' ? null : text, system), ...early })
  unreadBase = text === 'error' ? useStore.getState().preferences : null
  if (Object.keys(early).length) schedule()
}

/**
 * Before writing over a file that could not be read at startup, read it again. When it can be read
 * now, its values and unknown keys come back into the store with this session's changes on top, and
 * true is returned. False: it is still unreadable, so nothing may be written.
 */
async function rereadBeforeWrite(): Promise<boolean> {
  const base = unreadBase
  if (!base) return true
  const text = await readFile()
  if (text === 'error') return false
  const now = useStore.getState().preferences
  unreadBase = null
  actions().load({ ...fromFile(text, base.authorName), ...changesBetween(base, now) })
  return true
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
  writing = writing
    .then(async () => {
      if (!(await rereadBeforeWrite())) {
        // Still locked: never replace the real file with defaults. The next change tries again.
        pending = true
        console.warn('Preferences were not saved: preferences.json could not be read.')
        return
      }
      await invoke<void>(PREFERENCE_COMMANDS.write, { contents: serializePreferences(useStore.getState().preferences) })
    })
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
