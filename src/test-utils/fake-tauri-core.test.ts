import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { COMMANDS } from '@/features/storage/ipc'
import { createFakeTauriCore, HANDLED_COMMANDS, memoryPersistence } from './fake-tauri-core'

/** Plugin commands the app sends, with the plugin file that defines each name. */
const PLUGIN_COMMANDS: [command: string, definedIn: string][] = [
  ['plugin:dialog|message', 'node_modules/@tauri-apps/plugin-dialog/dist-js/index.js'],
  ['plugin:sql|load', 'node_modules/@tauri-apps/plugin-sql/dist-js/index.js'],
  ['plugin:sql|execute', 'node_modules/@tauri-apps/plugin-sql/dist-js/index.js'],
  ['plugin:sql|select', 'node_modules/@tauri-apps/plugin-sql/dist-js/index.js'],
  ['plugin:sql|close', 'node_modules/@tauri-apps/plugin-sql/dist-js/index.js'],
  ['plugin:window|theme', 'node_modules/@tauri-apps/api/window.js'],
  ['plugin:window|destroy', 'node_modules/@tauri-apps/api/window.js'],
  ['plugin:window|is_fullscreen', 'node_modules/@tauri-apps/api/window.js'],
  ['plugin:window|set_fullscreen', 'node_modules/@tauri-apps/api/window.js'],
  ['plugin:app|version', 'node_modules/@tauri-apps/api/app.js'],
]

function* sourceFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* sourceFiles(p)
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$|test-util/.test(name) && !p.includes('test-utils')) yield p
  }
}

/** Command names passed as string literals to invoke() anywhere in the shipped frontend. */
function literalInvokes(): string[] {
  const names = new Set<string>()
  for (const file of sourceFiles('src')) {
    for (const m of readFileSync(file, 'utf8').matchAll(/\binvoke(?:<[^>]*>)?\(\s*['"]([^'"]+)['"]/g)) names.add(m[1])
  }
  return [...names].sort()
}

/** True unless the core rejects `cmd` as unknown (other errors, e.g. confinement, mean it is handled). */
async function handles(cmd: string): Promise<boolean> {
  const core = createFakeTauriCore({ messageDialog: async () => 'OK' })
  try {
    await core.handle(cmd, { path: '/nowhere', db: 'sqlite:/x', query: 'SELECT 1', entries: [], name: 'n', title: 't', message: 'm' })
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('unexpected command')) return false
  }
  return true
}

describe('fake Tauri command core', () => {
  it('handles every storage command the frontend invokes (COMMANDS in storage/ipc.ts)', async () => {
    for (const cmd of Object.values(COMMANDS)) {
      expect(HANDLED_COMMANDS, cmd).toContain(cmd)
      expect(await handles(cmd), cmd).toBe(true)
    }
  })

  it('handles every command invoked by name elsewhere in src (e.g. list_system_fonts)', async () => {
    const names = literalInvokes()
    expect(names).toContain('list_system_fonts')
    for (const cmd of names) {
      expect(HANDLED_COMMANDS, cmd).toContain(cmd)
      expect(await handles(cmd), cmd).toBe(true)
    }
  })

  it('handles every plugin command the app uses, under the name the plugin really sends', async () => {
    for (const [cmd, file] of PLUGIN_COMMANDS) {
      expect(readFileSync(file, 'utf8'), `${cmd} in ${file}`).toContain(cmd)
      expect(HANDLED_COMMANDS, cmd).toContain(cmd)
      expect(await handles(cmd), cmd).toBe(true)
    }
  })

  it('lists nothing it does not handle, and rejects unknown commands', async () => {
    for (const cmd of HANDLED_COMMANDS) expect(await handles(cmd), cmd).toBe(true)
    expect(await handles('storage_format_disk')).toBe(false)
  })

  it('writes through to its persistence; a new core over the same disk sees the files ("relaunch")', async () => {
    const disk = memoryPersistence()
    const first = createFakeTauriCore({ persistence: disk, pickCreatesFolder: true })
    first.state.pick = '/books/novel'
    await first.handle('storage_pick_project_folder', { title: 't' })
    await first.handle('storage_write_file_atomic', { path: '/books/novel/manuscript.json', contents: '{}' })
    await first.handle('storage_remember_recent', { name: 'novel', openedAt: '2026-11-03T00:00:00Z' })
    await first.handle('plugin:sql|load', { db: 'sqlite:/books/novel/index.sqlite' })
    await first.handle('plugin:sql|execute', { db: 'sqlite:/books/novel/index.sqlite', query: 'PRAGMA user_version = 1' })

    const relaunched = createFakeTauriCore({ persistence: disk })
    await relaunched.hydrate()
    expect(relaunched.state.active).toBeNull()
    await relaunched.handle('storage_open_recent_root', { path: '/books/novel' })
    expect(await relaunched.handle('storage_read_text_file', { path: '/books/novel/manuscript.json' })).toBe('{}')
    await relaunched.handle('plugin:sql|load', { db: 'sqlite:/books/novel/index.sqlite' })
    expect(
      await relaunched.handle('plugin:sql|select', { db: 'sqlite:/books/novel/index.sqlite', query: 'PRAGMA user_version' }),
    ).toEqual([{ user_version: 1 }])
  })

  it('keeps Rust confinement: no root, outside the root, `..`, unlisted recent folders', async () => {
    const core = createFakeTauriCore()
    await expect(core.handle('storage_read_text_file', { path: '/a/b' })).rejects.toMatchObject({ kind: 'outside_project' })
    await core.seedFile('/books/a/project.json', '{}')
    await core.seedFile('/secret.txt', 's')
    await expect(core.handle('storage_open_recent_root', { path: '/books/a' })).rejects.toMatchObject({ kind: 'not_recent' })
    await core.seedRecent('/books/a', 'a')
    await core.handle('storage_open_recent_root', { path: '/books/a' })
    await expect(core.handle('storage_read_text_file', { path: '/books/a/../../secret.txt' })).rejects.toMatchObject({
      kind: 'outside_project',
    })
    await expect(core.handle('storage_path_exists', { path: '/books/a/../x' })).rejects.toMatchObject({ kind: 'invalid_path' })
    await expect(core.handle('storage_list_dir', { path: '/' })).rejects.toMatchObject({ kind: 'outside_project' })
    expect(await core.handle('storage_list_dir', { path: '/books/a' })).toEqual(['project.json'])
  })
})
