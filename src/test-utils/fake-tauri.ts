/**
 * Vitest adapter over the shared fake Tauri command core (./fake-tauri-core.ts): module mocks for
 * `@tauri-apps/api/core`, the dialog plugin and the SQL plugin that all route into the same
 * command handler the e2e backend uses. Map persistence. Test-only. Paths are POSIX-style.
 *
 *   vi.mock('@tauri-apps/api/core', async () => (await import('@/test-utils/fake-tauri')).coreModule)
 *   vi.mock('@tauri-apps/plugin-dialog', async () => (await import('@/test-utils/fake-tauri')).dialogModule)
 *   vi.mock('@tauri-apps/plugin-sql', async () => (await import('@/test-utils/fake-tauri')).sqlModule)
 *
 * `backend` is the core's live state plus the message-box answers: tests set `backend.pick`,
 * `backend.answer`, `backend.failWrite`, ... and read `backend.files`, `backend.messages`, ...
 */
import { createFakeTauriCore, memoryPersistence, type MessageDialogArgs } from './fake-tauri-core'

const disk = memoryPersistence()

const dialog = {
  messages: [] as { text: string; opts: unknown }[],
  /** Button result of the next message dialog. */
  answer: 'Cancel' as string,
  /** If true, the message dialog rejects (plugin failure). */
  failDialog: false,
}

export const core = createFakeTauriCore({
  persistence: disk,
  messageDialog: async ({ message, ...opts }: MessageDialogArgs) => {
    // `backend` (defined below) carries the live answer settings.
    if (backend.failDialog) throw new Error('dialog plugin unavailable')
    backend.messages.push({ text: message, opts })
    return backend.answer
  },
})

type Backend = typeof core.state & typeof dialog & { reset(): void }

export const backend: Backend = Object.assign(core.state, dialog, {
  reset() {
    core.reset()
    disk.records.clear()
    backend.messages.length = 0
    backend.answer = 'Cancel'
    backend.failDialog = false
  },
})

export const invokeMock = (cmd: string, args: Record<string, unknown> = {}) => core.handle(cmd, args)

export const coreModule = { isTauri: () => true, invoke: invokeMock }

/** @tauri-apps/plugin-dialog `message()`, sent as the plugin sends it. */
export const dialogModule = {
  message: (message: string, opts: Record<string, unknown> = {}) =>
    core.handle('plugin:dialog|message', { ...opts, message }) as Promise<string>,
}

/** @tauri-apps/plugin-sql `Database`, each call sent as the plugin sends it. */
export const sqlModule = {
  default: {
    load: async (url: string) => {
      const db = (await core.handle('plugin:sql|load', { db: url })) as string
      return {
        path: db,
        execute: async (query: string, values: unknown[] = []) => {
          const [rowsAffected, lastInsertId] = (await core.handle('plugin:sql|execute', { db, query, values })) as [
            number,
            number,
          ]
          return { rowsAffected, lastInsertId }
        },
        select: (query: string, values: unknown[] = []) => core.handle('plugin:sql|select', { db, query, values }),
        close: (target?: string) => core.handle('plugin:sql|close', { db: target ?? db }),
      }
    },
  },
}
