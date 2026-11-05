import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getEditor } from '@/features/editor'
import {
  getCommands,
  menuBarKind,
  nativeMenuSnapshot,
  runFromNativeMenu,
  subscribeCommands,
  subscribeCommandState,
} from '@/shared/commands'

/** Event Rust sends with the id of the chosen native menu item (src-tauri/src/menu.rs). */
export const MENU_COMMAND_EVENT = 'menu://command'

/** Registry changes come in bursts (a slice registers many commands): coalesce them. */
const REGISTRY_SETTLE_MS = 30

/**
 * Keep the native macOS menu in step with the registry: the snapshot is sent on registry changes and
 * (debounced) state changes, only when it differs from the last one sent; Rust updates enabled/checked
 * state in place when the structure is unchanged. Chosen items arrive as `menu://command`; one whose
 * shortcut the webview just handled is the same key press and is not run again.
 *
 * Runs in the macOS app and in the e2e build (whose fake backend records the snapshot). Returns stop.
 */
export function startNativeMenu(opts: { force?: boolean } = {}): () => void {
  if (!opts.force && menuBarKind() !== 'native' && import.meta.env.MODE !== 'e2e') return () => {}
  let last = ''
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  const send = () => {
    timer = null
    if (stopped) return
    const snapshot = nativeMenuSnapshot(getCommands())
    const json = JSON.stringify(snapshot)
    if (json === last) return
    last = json
    invoke('menu_set', { snapshot }).catch((e) => console.warn('Updating the native menu failed:', e))
  }
  const schedule = () => {
    if (timer === null) timer = setTimeout(send, REGISTRY_SETTLE_MS)
  }
  schedule()
  const offCommands = subscribeCommands(schedule)
  const offState = subscribeCommandState(send)
  let unlisten: (() => void) | null = null
  listen<string>(MENU_COMMAND_EVENT, (e) => {
    runFromNativeMenu(e.payload, getEditor()?.view.dom)
  })
    .then((un) => (stopped ? un() : (unlisten = un)))
    .catch((e) => console.warn('Native menu events unavailable:', e))
  return () => {
    stopped = true
    if (timer !== null) clearTimeout(timer)
    offCommands()
    offState()
    unlisten?.()
  }
}
