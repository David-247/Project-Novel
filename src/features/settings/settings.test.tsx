import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setSystemAuthorName, useStore } from '@/shared/store'
import { TooltipProvider } from '@/shared/ui'
import { auditTooltipCoverage, formatCoverageProblems, getTooltipCopy } from '@/features/tooltips'
import { backend } from '@/test-utils/fake-tauri'

vi.mock('@tauri-apps/api/core', async () => (await import('@/test-utils/fake-tauri')).coreModule)

import {
  closeSettings,
  ensureAuthorName,
  getAuthor,
  openSettings,
  prefersReducedMotion,
  SETTINGS_CONTROLS,
  SettingsButton,
  SettingsDialog,
  useAuthor,
  useSettingsIntegration,
} from './index'
import { flushPreferences, loadPreferences, startPreferencesWriter, WRITE_DEBOUNCE_MS } from './persistence'
import { resolveReduceMotion } from './motion'

const prefs = () => useStore.getState().preferences
const actions = () => useStore.getState().preferencesActions

function resetStore() {
  setSystemAuthorName('')
  actions().reset()
  useStore.setState((s) => ({ preferences: { ...s.preferences, loaded: false, extra: {}, authorPrompted: false, authorName: '' } }))
}

beforeEach(() => {
  backend.reset()
  resetStore()
})

afterEach(() => {
  act(() => closeSettings())
  cleanup()
  vi.useRealTimers()
})

describe('loading preferences.json', () => {
  it('uses the OS user name when there is no file, and does not write anything', async () => {
    backend.defaultAuthor = 'Ada Lovelace'
    await loadPreferences()
    expect(prefs()).toMatchObject({ authorName: 'Ada Lovelace', pageNavigation: 'book', loaded: true })
    expect(backend.preferences).toBeNull()
  })

  it('reads a saved file, ignoring the OS name', async () => {
    backend.defaultAuthor = 'Account'
    backend.preferences = JSON.stringify({ version: 1, authorName: 'Pen Name', pageNavigation: 'scroll', defaultTrimSize: 'uk-a5', extra1: 1 })
    await loadPreferences()
    expect(prefs()).toMatchObject({ authorName: 'Pen Name', pageNavigation: 'scroll', defaultTrimSize: 'uk-a5', extra: { extra1: 1 } })
  })

  it('a damaged file starts the app on defaults, and the next change repairs the file', async () => {
    vi.useFakeTimers()
    backend.defaultAuthor = 'Account'
    backend.preferences = '{ this is not json'
    const stop = startPreferencesWriter()
    await loadPreferences()
    expect(prefs()).toMatchObject({ authorName: 'Account', pageNavigation: 'book', loaded: true })
    expect(backend.preferences).toBe('{ this is not json') // loading never writes
    act(() => actions().set('pageNavigation', 'scroll'))
    await vi.advanceTimersByTimeAsync(WRITE_DEBOUNCE_MS + 10)
    expect(JSON.parse(backend.preferences!)).toMatchObject({ version: 1, authorName: 'Account', pageNavigation: 'scroll' })
    stop()
  })

  it('a failing backend leaves the defaults and the app running', async () => {
    const original = backend.preferences
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    backend.defaultAuthor = ''
    // No OS name and no file: the name stays empty (asked once on the first tracked change).
    await loadPreferences()
    expect(prefs()).toMatchObject({ authorName: '', loaded: true })
    expect(backend.preferences).toBe(original)
    spy.mockRestore()
  })
})

describe('writing preferences.json', () => {
  it('debounces a burst of changes into one write, keeping unknown keys', async () => {
    vi.useFakeTimers()
    backend.preferences = JSON.stringify({ version: 1, authorName: 'A', keepMe: { x: 1 } })
    const stop = startPreferencesWriter()
    await loadPreferences()
    const before = backend.writes.length
    act(() => {
      actions().set('authorName', 'Al')
      actions().set('authorName', 'Ali')
      actions().set('authorName', 'Alic')
    })
    await vi.advanceTimersByTimeAsync(WRITE_DEBOUNCE_MS - 50)
    expect(backend.preferenceWrites).toBe(0)
    await vi.advanceTimersByTimeAsync(100)
    expect(backend.preferenceWrites).toBe(1)
    expect(JSON.parse(backend.preferences!)).toMatchObject({ authorName: 'Alic', keepMe: { x: 1 } })
    expect(backend.writes.length).toBe(before) // never touches project files
    stop()
  })

  it('flushPreferences writes at once', async () => {
    const stop = startPreferencesWriter()
    await loadPreferences()
    act(() => actions().set('reduceMotion', 'on'))
    await flushPreferences()
    expect(JSON.parse(backend.preferences!)).toMatchObject({ reduceMotion: 'on' })
    stop()
  })

  it('persists across a restart (a new load reads what was written)', async () => {
    const stop = startPreferencesWriter()
    await loadPreferences()
    act(() => actions().set('authorName', 'Kept'))
    await flushPreferences()
    stop()
    resetStore()
    await loadPreferences()
    expect(prefs().authorName).toBe('Kept')
  })

  it('holds no credentials: only the documented keys are written', async () => {
    const stop = startPreferencesWriter()
    await loadPreferences()
    act(() => actions().set('authorName', 'X'))
    await flushPreferences()
    expect(Object.keys(JSON.parse(backend.preferences!)).sort()).toEqual(
      ['authorColor', 'authorName', 'authorPrompted', 'defaultPaper', 'defaultTrimSize', 'pageNavigation', 'reduceMotion', 'version'],
    )
    stop()
  })
})

describe('author', () => {
  it('getAuthor / useAuthor give the trimmed name and colour', () => {
    act(() => {
      actions().set('authorName', '  Ada  ')
      actions().set('authorColor', '#112233')
    })
    expect(getAuthor()).toEqual({ name: 'Ada', color: '#112233' })
    function Probe() {
      const a = useAuthor()
      return <p>{`${a.name}|${a.color}`}</p>
    }
    render(<Probe />)
    expect(screen.getByText('Ada|#112233')).toBeInTheDocument()
  })

  it('ensureAuthorName returns a known name without asking', async () => {
    actions().load({ authorName: 'Ada' })
    render(<SettingsDialog />)
    expect(await ensureAuthorName()).toBe('Ada')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  function renderApp() {
    return render(
      <TooltipProvider lookup={getTooltipCopy}>
        <SettingsDialog />
      </TooltipProvider>,
    )
  }

  it('asks once when no name is known, saves the answer, and never asks again', async () => {
    actions().load({ authorName: '' })
    renderApp()
    let first!: Promise<string>
    let second!: Promise<string>
    act(() => {
      first = ensureAuthorName()
      second = ensureAuthorName() // concurrent callers share the one question
    })
    const field = await screen.findByRole('textbox', { name: SETTINGS_CONTROLS.promptName.label })
    expect(screen.getByRole('button', { name: SETTINGS_CONTROLS.promptSave.label })).toBeDisabled()
    fireEvent.change(field, { target: { value: '  Grace Hopper ' } })
    fireEvent.click(screen.getByRole('button', { name: SETTINGS_CONTROLS.promptSave.label }))
    expect(await first).toBe('Grace Hopper')
    expect(await second).toBe('Grace Hopper')
    expect(prefs()).toMatchObject({ authorName: 'Grace Hopper', authorPrompted: true })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(await ensureAuthorName()).toBe('Grace Hopper')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('a dismissed question is not asked again: the call resolves with an empty name', async () => {
    actions().load({ authorName: '' })
    renderApp()
    let pending!: Promise<string>
    act(() => {
      pending = ensureAuthorName()
    })
    fireEvent.click(await screen.findByRole('button', { name: SETTINGS_CONTROLS.promptSkip.label }))
    expect(await pending).toBe('')
    expect(prefs()).toMatchObject({ authorName: '', authorPrompted: true })
    expect(await ensureAuthorName()).toBe('')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('does not ask while a name is known from the OS (loaded at startup)', async () => {
    backend.defaultAuthor = 'Account'
    await loadPreferences()
    renderApp()
    expect(await ensureAuthorName()).toBe('Account')
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('Settings dialog', () => {
  function renderApp() {
    function Host() {
      useSettingsIntegration()
      return (
        <TooltipProvider lookup={getTooltipCopy}>
          <SettingsButton />
          <SettingsDialog />
        </TooltipProvider>
      )
    }
    return render(<Host />)
  }

  it('opens from the gear, labels every field, and has a tooltip on every control', async () => {
    renderApp()
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    const dialog = await screen.findByRole('dialog', { name: 'Settings' })
    for (const key of ['authorName', 'authorColor', 'pageNavigation', 'reduceMotion', 'defaultPaper', 'defaultTrimSize'] as const) {
      expect(dialog.querySelector(`[data-control-id="${SETTINGS_CONTROLS[key].id}"]`), key).not.toBeNull()
    }
    for (const section of ['General', 'Writing view', 'New projects']) {
      expect(screen.getByRole('region', { name: section })).toBeInTheDocument()
    }
    expect(screen.getByLabelText('Page navigation')).toBeEnabled()
    const problems = auditTooltipCoverage(document.body)
    expect(problems, formatCoverageProblems(problems)).toEqual([])
  })

  it('changes apply immediately, and Reset to defaults puts everything back', async () => {
    renderApp()
    act(() => openSettings())
    await screen.findByRole('dialog', { name: 'Settings' })
    fireEvent.change(screen.getByLabelText('Author name'), { target: { value: 'Ada' } })
    fireEvent.change(screen.getByLabelText('Page navigation'), { target: { value: 'scroll' } })
    fireEvent.change(screen.getByLabelText('Motion'), { target: { value: 'on' } })
    fireEvent.change(screen.getByLabelText('Paper'), { target: { value: 'dark' } })
    fireEvent.change(screen.getByLabelText('Trim size'), { target: { value: 'uk-a5' } })
    fireEvent.change(screen.getByLabelText('Author colour'), { target: { value: '#aa3366' } })
    expect(prefs()).toMatchObject({
      authorName: 'Ada',
      pageNavigation: 'scroll',
      reduceMotion: 'on',
      defaultPaper: 'dark',
      defaultTrimSize: 'uk-a5',
      authorColor: '#aa3366',
    })
    expect(document.documentElement.dataset.reduceMotion).toBe('on')
    fireEvent.click(screen.getByRole('button', { name: 'Automatic colour' }))
    expect(prefs().authorColor).toBeNull()
    setSystemAuthorName('Account')
    fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }))
    expect(prefs()).toMatchObject({
      authorName: 'Account',
      authorColor: null,
      pageNavigation: 'book',
      reduceMotion: 'system',
      defaultPaper: 'auto',
      defaultTrimSize: 'us-5.5x8.5',
    })
    expect(document.documentElement.dataset.reduceMotion).toBeUndefined()
  })

  it('closes with Escape and Done, giving focus back to the gear', async () => {
    renderApp()
    const gear = screen.getByRole('button', { name: 'Settings' })
    gear.focus()
    fireEvent.click(gear)
    await screen.findByRole('dialog', { name: 'Settings' })
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(gear).toHaveFocus())
    fireEvent.click(gear)
    fireEvent.click(await screen.findByRole('button', { name: 'Done' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  // Last on purpose: a key press arms the tooltips' keyboard-focus window (1 s), and a focus tooltip
  // on the gear would take the next Escape in a following test.
  it('opens on Mod-, (Ctrl+, off macOS) from anywhere', async () => {
    renderApp()
    fireEvent.keyDown(window, { key: ',', ctrlKey: true })
    expect(await screen.findByRole('dialog', { name: 'Settings' })).toBeInTheDocument()
  })
})

describe('reduced motion', () => {
  it('resolves the preference against the OS setting', () => {
    expect(resolveReduceMotion('on', false)).toBe(true)
    expect(resolveReduceMotion('off', true)).toBe(false)
    expect(resolveReduceMotion('system', true)).toBe(true)
    expect(resolveReduceMotion('system', false)).toBe(false)
  })

  it('prefersReducedMotion reads the store', () => {
    actions().set('reduceMotion', 'on')
    expect(prefersReducedMotion()).toBe(true)
    actions().set('reduceMotion', 'off')
    expect(prefersReducedMotion()).toBe(false)
  })
})
