import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { getEditor, getChapters, getResolvedStyles, setDocJSON } from '@/features/editor'
import {
  __resetExportRenderersForTests,
  __resetExportSettingsForTests,
  __resetWizardForTests,
  createMockExportRenderers,
  EXPORT_COMMAND_IDS,
  EXPORT_WIZARD_CONTROLS as C,
  getLastOutputFolder,
  getManuscriptSettings,
  getWizardState,
  setExportRenderers,
  useLastOutputFolder,
  WIZARD_FIXTURE_DOC,
  WIZARD_FIXTURE_REWRITES,
  WIZARD_FIXTURE_STYLES,
} from '@/features/export'
import { openProject, saveProject } from '@/features/storage'
import { auditTooltipCoverage, formatCoverageProblems } from '@/features/tooltips'
import { getCommand, isCommandEnabled } from '@/shared/commands'
import { useStore } from '@/shared/store'
import { backend, core } from '@/test-utils/fake-tauri'
import { App } from './App'

vi.mock('@tauri-apps/api/core', async () => (await import('@/test-utils/fake-tauri')).coreModule)
vi.mock('@tauri-apps/plugin-dialog', async () => (await import('@/test-utils/fake-tauri')).dialogModule)
vi.mock('@tauri-apps/plugin-sql', async () => (await import('@/test-utils/fake-tauri')).sqlModule)
// The window and event APIs the whole app touches (theme, close request, native menu events).
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    theme: async () => null,
    onThemeChanged: async () => () => {},
    onCloseRequested: async () => () => {},
    destroy: async () => {},
    isFullscreen: async () => false,
    setFullscreen: async () => {},
  }),
}))
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }))
vi.mock('@tauri-apps/api/app', () => ({ getVersion: async () => '0.3.0' }))

// The export wizard in the whole app (T8): every step, every check, the export with the mock renderers.

beforeAll(() => {
  const rect = { x: 0, y: 0, top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, toJSON: () => ({}) }
  const emptyRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList
  Range.prototype.getClientRects ??= emptyRects
  Range.prototype.getBoundingClientRect ??= () => rect as DOMRect
  Element.prototype.getClientRects ??= emptyRects
  Element.prototype.scrollIntoView ??= () => {}
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.releasePointerCapture ??= () => {}
  document.elementFromPoint ??= () => null
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

const ex = core.exports
let offRenderers = () => {}

beforeEach(() => {
  backend.reset()
  __resetWizardForTests()
  __resetExportSettingsForTests()
  offRenderers = setExportRenderers(createMockExportRenderers())
  // The app loads preferences.json at start: the profile is set once that is done (setProfile).
  useStore.setState((s) => ({ preferences: { ...s.preferences, loaded: false } }))
})

async function setProfile() {
  await waitFor(() => expect(useStore.getState().preferences.loaded).toBe(true))
  act(() => {
    const p = useStore.getState().preferencesActions
    p.set('profileLegalName', 'Ann Waight')
    p.set('profileEmail', 'ann@example.com')
    p.set('profilePenName', '')
    p.set('profileAddress', '')
    p.set('profilePhone', '')
    p.set('profileAgent', '')
  })
}

afterEach(() => {
  act(() => __resetWizardForTests())
  offRenderers()
  __resetExportRenderersForTests()
  cleanup()
  useStore.getState().rewriteActions.loaded([])
  setDocJSON({ type: 'doc', content: [{ type: 'paragraph' }] })
})

const ctl = (id: string) => document.querySelector<HTMLElement>(`[data-control-id="${id}"]`)
const dialog = () => document.querySelector<HTMLElement>('[data-testid="export-wizard"]')
const checkEl = (id: string) => dialog()!.querySelector<HTMLElement>(`[data-check="${id}"]`)

async function renderApp(title = 'The Long Night') {
  render(<App />)
  await waitFor(() => expect(getEditor()).not.toBeNull())
  await waitFor(() => expect(getCommand(EXPORT_COMMAND_IDS.manuscript)).toBeDefined())
  await setProfile()
  act(() => {
    useStore.getState().bookActions.setStyles(() => WIZARD_FIXTURE_STYLES as never)
    useStore.getState().rewriteActions.loaded(WIZARD_FIXTURE_REWRITES.rewrites as never)
    setDocJSON(WIZARD_FIXTURE_DOC)
  })
  if (title) {
    openWizard()
    await typeInto(C.title.id, title)
    closeWizard()
  }
}

function openWizard() {
  act(() => getCommand(EXPORT_COMMAND_IDS.manuscript)!.run())
  expect(dialog()).not.toBeNull()
}
function closeWizard() {
  act(() => fireEvent.click((ctl(C.cancel.id) ?? ctl(C.finish.id))!))
}
async function typeInto(id: string, value: string) {
  const el = ctl(id) as HTMLInputElement
  act(() => {
    el.focus()
    fireEvent.change(el, { target: { value } })
  })
  act(() => {
    fireEvent.blur(el)
  })
}
/** Alt+<key> with the focus in the wizard (on its focused control, else the dialog itself). */
const alt = (code: string) =>
  act(() => {
    const target = dialog()!.contains(document.activeElement) ? document.activeElement! : dialog()!
    fireEvent.keyDown(target, { key: code.slice(-1).toLowerCase(), code, altKey: true })
  })
const flush = () => act(async () => new Promise((r) => setTimeout(r, 30)))
const audit = (where: string) => {
  const problems = auditTooltipCoverage(dialog()!)
  expect(problems, `${where}\n${formatCoverageProblems(problems)}`).toEqual([])
}

describe('File > Export > Manuscript…', () => {
  it('opens the wizard; Alt+N / Alt+B / Alt+<digit> move between the four steps; every control has its tooltip', async () => {
    await renderApp()
    openWizard()
    expect(getWizardState().step).toBe('title')
    audit('title page')
    alt('KeyN')
    expect(getWizardState().step).toBe('format')
    audit('formatting')
    alt('Digit3')
    expect(getWizardState().step).toBe('checks')
    audit('checks')
    alt('KeyN')
    expect(getWizardState().step).toBe('export')
    audit('export')
    alt('KeyB')
    expect(getWizardState().step).toBe('checks')
    // The step list marks the current step.
    expect(ctl(C.stepChecks.id)).toHaveAttribute('aria-current', 'step')
  })

  it('the title page preview, the word count with its rounding and the header preview follow the fields', async () => {
    await renderApp()
    openWizard()
    const q = (id: string) => dialog()!.querySelector(`[data-testid="${id}"]`)!.textContent
    expect(q('preview-title')).toBe('The Long Night')
    expect(q('preview-byline')).toBe('A Novel by Ann Waight')
    expect(q('preview-contact')).toContain('ann@example.com')
    expect(q('wizard-wordcount')).toMatch(/^about \d+ words/)
    await typeInto(C.penName.id, 'A. W. Night')
    expect(q('preview-byline')).toBe('A Novel by A. W. Night')
    // Rounding 'exact' prints the count without "about".
    act(() => fireEvent.change(ctl(C.rounding.id)!, { target: { value: 'exact' } }))
    expect(q('preview-wordcount')).not.toMatch(/about/)
    act(() => fireEvent.click(ctl(C.next.id)!))
    expect(q('preview-header')).toBe('Night / The Long Night / 1')
    expect(q('preview-page-header')).toBe('Night / The Long Night / 1')
  })

  it('text fields keep a local draft: clearing the scene-break marker does not snap back to "#" while typing', async () => {
    await renderApp()
    openWizard()
    alt('Digit2')
    const marker = ctl(C.sceneBreak.id) as HTMLInputElement
    act(() => {
      marker.focus()
      fireEvent.change(marker, { target: { value: '' } })
    })
    expect(marker.value).toBe('')
    act(() => fireEvent.change(marker, { target: { value: '* ' } }))
    expect(marker.value).toBe('* ')
    expect(getManuscriptSettings().sceneBreak).toBe('* ')
    act(() => fireEvent.change(marker, { target: { value: '' } }))
    act(() => fireEvent.blur(marker))
    // Blank on blur: the stored value shows again.
    expect(marker.value).toBe('* ')
  })

  it('every check fires on the wizard fixture; blocking checks disable Export until fixed', async () => {
    await renderApp('')
    openWizard()
    act(() => useStore.getState().preferencesActions.set('profileEmail', ''))
    alt('Digit3')
    for (const [id, severity] of [
      ['title', 'blocking'],
      ['contact', 'blocking'],
      ['word-count', 'info'],
      ['tracked-changes', 'warning'],
      ['comments', 'info'],
      ['rewrites', 'warning'],
      ['chapters', 'warning'],
      ['scene-breaks', 'info'],
      ['formatting', 'info'],
      ['double-spaces', 'info'],
    ] as const) {
      expect(checkEl(id), id).toHaveAttribute('data-severity', severity)
    }
    alt('Digit4')
    const exportButton = ctl(C.start.id)!
    expect(exportButton).toHaveAttribute('aria-disabled', 'true')
    act(() => fireEvent.click(exportButton))
    expect(ex.dialogs).toHaveLength(0)
    // Fix: the title check's action goes to the field and focuses it.
    alt('Digit3')
    act(() => fireEvent.click(checkEl('title')!.querySelector(`[data-control-id="${C.checkFix.id}"]`)!))
    expect(getWizardState().step).toBe('title')
    await flush()
    expect(document.activeElement).toBe(ctl(C.title.id))
    await typeInto(C.title.id, 'The Long Night')
    await typeInto(C.email.id, 'ann@example.com')
    alt('Digit4')
    expect(ctl(C.start.id)).not.toHaveAttribute('aria-disabled')
  })

  it('Show me closes the wizard and puts the caret at the chapter; reopening returns to Checks', async () => {
    await renderApp()
    openWizard()
    alt('Digit3')
    const showMe = checkEl('chapters')!.querySelectorAll<HTMLElement>(`[data-control-id="${C.checkShowChapter.id}"]`)
    expect(showMe).toHaveLength(3)
    act(() => fireEvent.click(showMe[0]))
    expect(dialog()).toBeNull()
    await flush()
    const ed = getEditor()!
    const untitled = getChapters(ed.state.doc, getResolvedStyles(), 'none').find((c) => c.index === 2)!
    expect(ed.state.selection.from).toBe(untitled.from + 1)
    openWizard()
    expect(getWizardState().step).toBe('checks')
  })

  it('Review changes, Show comments and Open re-write close the wizard and run their review commands', async () => {
    await renderApp()
    for (const [check, action, after] of [
      ['tracked-changes', C.checkReviewChanges.id, () => expect(getEditor()!.state.selection.empty).toBe(false)],
      ['comments', C.checkShowComments.id, () => expect(useStore.getState().comments.panelOpen).toBe(true)],
      ['rewrites', C.checkOpenRewrite.id, () => expect(useStore.getState().rewrite.openId).toBe('rw-1')],
    ] as const) {
      openWizard()
      if (getWizardState().step !== 'checks') alt('Digit3')
      act(() => fireEvent.click(checkEl(check)!.querySelector(`[data-control-id="${action}"]`)!))
      expect(dialog(), check).toBeNull()
      await flush()
      after()
      act(() => getCommand('rewrite.close')?.run())
    }
  })

  it('the export-only options: one space after a full stop; blank lines left out instead of scene breaks', async () => {
    await renderApp()
    openWizard()
    alt('Digit3')
    expect(checkEl('scene-breaks')!.textContent).toMatch(/1 blank line/)
    act(() => fireEvent.click(ctl(C.blankLines.id)!))
    expect(getManuscriptSettings().checks.blankLineSceneBreaks).toBe('off')
    expect(checkEl('scene-breaks')!.textContent).not.toMatch(/blank line will/)
    act(() => fireEvent.click(ctl(C.normalizeSpaces.id)!))
    expect(getManuscriptSettings().checks.normalizeSpaces).toBe(true)
    alt('Digit4')
    act(() => fireEvent.click(ctl(C.start.id)!))
    await waitFor(() => expect(dialog()!.querySelector('[data-testid="export-done"]')).not.toBeNull())
    const text = new TextDecoder().decode(ex.written.get('/exports/Waight_THE_LONG_NIGHT_manuscript.docx'))
    expect(text).toContain('He waited. Nobody came.')
    // The manuscript keeps its two spaces.
    expect(getEditor()!.state.doc.textContent).toContain('He waited.  Nobody came.')
  })
})

describe('exporting', () => {
  it('exports DOCX and PDF to the Save-dialog paths, with the default names; Open file and Show in folder', async () => {
    await renderApp()
    openWizard()
    alt('Digit4')
    expect(dialog()!.querySelector('[data-testid="export-file-names"]')!.textContent).toBe('Waight_THE_LONG_NIGHT_manuscript.docxWaight_THE_LONG_NIGHT_manuscript.pdf')
    alt('KeyE')
    await waitFor(() => expect(dialog()!.querySelector('[data-testid="export-done"]')).not.toBeNull())
    expect(ex.dialogs.map((d) => [d.kind, d.defaultName])).toEqual([
      ['docx', 'Waight_THE_LONG_NIGHT_manuscript.docx'],
      ['pdf', 'Waight_THE_LONG_NIGHT_manuscript.pdf'],
    ])
    expect([...ex.written.keys()]).toEqual(['/exports/Waight_THE_LONG_NIGHT_manuscript.docx', '/exports/Waight_THE_LONG_NIGHT_manuscript.pdf'])
    audit('export done')
    const open = dialog()!.querySelectorAll<HTMLElement>(`[data-control-id="${C.openFile.id}"]`)
    const show = dialog()!.querySelectorAll<HTMLElement>(`[data-control-id="${C.showInFolder.id}"]`)
    act(() => fireEvent.click(open[0]))
    act(() => fireEvent.click(show[1]))
    await flush()
    expect(ex.opens).toEqual(['/exports/Waight_THE_LONG_NIGHT_manuscript.docx'])
    expect(ex.reveals).toEqual(['/exports/Waight_THE_LONG_NIGHT_manuscript.pdf'])
  })

  it('only the formats chosen; a format with no renderer cannot be chosen', async () => {
    await renderApp()
    offRenderers()
    offRenderers = setExportRenderers({ docx: createMockExportRenderers().docx })
    openWizard()
    alt('Digit4')
    expect(ctl(C.formatPdf.id)).toBeDisabled()
    alt('KeyE')
    await waitFor(() => expect(dialog()!.querySelector('[data-testid="export-done"]')).not.toBeNull())
    expect([...ex.written.keys()]).toEqual(['/exports/Waight_THE_LONG_NIGHT_manuscript.docx'])
  })

  it('cancelling the Save dialog exports nothing and leaves the step ready', async () => {
    await renderApp()
    ex.savePath = null
    openWizard()
    alt('Digit4')
    alt('KeyE')
    await flush()
    expect(getWizardState().run.phase).toBe('ready')
    expect(ex.written.size).toBe(0)
  })

  it('Cancel during the export writes no file', async () => {
    await renderApp()
    offRenderers()
    offRenderers = setExportRenderers(createMockExportRenderers({ delayMs: 40 }))
    openWizard()
    alt('Digit4')
    alt('KeyE')
    await waitFor(() => expect(ctl(C.cancelRun.id)).not.toBeNull())
    act(() => fireEvent.click(ctl(C.cancelRun.id)!))
    await waitFor(() => expect(dialog()!.querySelector('[data-testid="export-cancelled"]')).not.toBeNull())
    expect(ex.written.size).toBe(0)
  })

  it('closing the wizard during the export cancels it, writing nothing', async () => {
    await renderApp()
    offRenderers()
    offRenderers = setExportRenderers(createMockExportRenderers({ delayMs: 40 }))
    openWizard()
    alt('Digit4')
    alt('KeyE')
    await waitFor(() => expect(getWizardState().run.phase).toBe('rendering'))
    closeWizard()
    await waitFor(() => expect(getWizardState().run.phase).toBe('cancelled'))
    await act(async () => new Promise((r) => setTimeout(r, 300)))
    expect(ex.written.size).toBe(0)
  })

  it.each([
    ['disk_full', 'disk-full', /disk is full/],
    ['permission_denied', 'permission', /not allowed to save/],
    ['not_found', 'missing-folder', /no longer exists/],
  ] as const)('a %s write error is shown with Retry and Choose another location', async (kind, problem, message) => {
    await renderApp()
    ex.failWrite = { kind, message: `simulated ${kind}`, diagnostics: [] }
    openWizard()
    alt('Digit4')
    alt('KeyE')
    await waitFor(() => expect(dialog()!.querySelector('[data-testid="export-error"]')).not.toBeNull())
    const panel = dialog()!.querySelector('[data-testid="export-error"]')!
    expect(panel).toHaveAttribute('data-problem', problem)
    expect(panel.textContent).toMatch(message)
    expect(ctl(C.chooseLocation.id)).not.toBeNull()
    audit(`error ${kind}`)
    ex.failWrite = null
    act(() => fireEvent.click(ctl(C.retry.id)!))
    await waitFor(() => expect(dialog()!.querySelector('[data-testid="export-done"]')).not.toBeNull())
    expect(ex.written.size).toBe(2)
  })

  it('Choose another location asks again and exports there', async () => {
    await renderApp()
    ex.failWrite = { kind: 'read_only', message: 'read-only volume', diagnostics: [] }
    openWizard()
    alt('Digit4')
    alt('KeyE')
    await waitFor(() => expect(ctl(C.chooseLocation.id)).not.toBeNull())
    ex.failWrite = null
    ex.savePath = '/elsewhere/Book.docx'
    act(() => fireEvent.click(ctl(C.chooseLocation.id)!))
    await waitFor(() => expect(dialog()!.querySelector('[data-testid="export-done"]')).not.toBeNull())
    expect(ex.written.has('/elsewhere/Book.docx')).toBe(true)
  })

  it('a renderer failure (a Typst error in the PDF) is shown with Retry', async () => {
    await renderApp()
    let fail = true
    offRenderers()
    const mock = createMockExportRenderers()
    offRenderers = setExportRenderers({
      ...mock,
      pdf: { format: 'pdf', render: (job, o) => (fail ? Promise.reject(new Error('Typst: unknown font')) : mock.pdf.render(job, o)) },
    })
    openWizard()
    alt('Digit4')
    alt('KeyE')
    await waitFor(() => expect(dialog()!.querySelector('[data-testid="export-error"]')).not.toBeNull())
    expect(dialog()!.querySelector('[data-testid="export-error"]')!.textContent).toMatch(/The PDF could not be made: Typst: unknown font/)
    expect(ex.written.size).toBe(0)
    fail = false
    alt('KeyR')
    await waitFor(() => expect(dialog()!.querySelector('[data-testid="export-done"]')).not.toBeNull())
  })
})

describe('Export Manuscript Again', () => {
  it('is disabled before any export; afterwards it replaces the same files after confirming, without the wizard', async () => {
    await renderApp()
    const again = getCommand(EXPORT_COMMAND_IDS.again)!
    expect(isCommandEnabled(again)).toBe(false)
    openWizard()
    alt('Digit4')
    alt('KeyE')
    await waitFor(() => expect(getWizardState().run.phase).toBe('done'))
    closeWizard()
    expect(isCommandEnabled(again)).toBe(true)
    ex.written.clear()
    // Declined: nothing happens.
    backend.answer = 'Cancel'
    await act(async () => again.run())
    await flush()
    expect(ex.written.size).toBe(0)
    backend.answer = 'Replace'
    await act(async () => again.run())
    await waitFor(() => expect(ex.written.size).toBe(2))
    expect(backend.messages.at(-1)!.text).toBe('Replace Waight_THE_LONG_NIGHT_manuscript.docx and Waight_THE_LONG_NIGHT_manuscript.pdf with the manuscript as it is now?')
    // No Save dialog and no wizard: the status bar says it.
    expect(ex.dialogs).toHaveLength(2)
    expect(dialog()).toBeNull()
    await waitFor(() => expect(document.querySelector('[data-testid="export-status"]')!.textContent).toMatch(/Exported Waight_THE_LONG_NIGHT_manuscript\.docx/))
    expect(auditTooltipCoverage(document.querySelector('[data-testid="export-status"]')!)).toEqual([])
  })

  it('a blocking check opens the wizard at Checks instead', async () => {
    await renderApp()
    openWizard()
    alt('Digit4')
    alt('KeyE')
    await waitFor(() => expect(getWizardState().run.phase).toBe('done'))
    closeWizard()
    act(() => useStore.getState().preferencesActions.set('profileLegalName', ''))
    await act(async () => getCommand(EXPORT_COMMAND_IDS.again)!.run())
    expect(dialog()).not.toBeNull()
    expect(getWizardState().step).toBe('checks')
  })
})

/** Open a project, discarding what an earlier test left unsaved (book styles) if asked. */
async function open(folder: string) {
  const answer = backend.answer
  backend.answer = "Don't Save"
  expect(await act(() => openProject(folder))).toBe(true)
  backend.answer = answer
}

describe('with a project', () => {
  const FOLDER = '/books/night'
  function seed() {
    backend.dirs.add(FOLDER)
    backend.files.set(`${FOLDER}/project.json`, JSON.stringify({ format: 'novel-project', schemaVersion: 1, id: 'night-id', title: 'The Long Night', createdAt: 'a', updatedAt: 'b' }))
    backend.files.set(`${FOLDER}/manuscript.json`, JSON.stringify(WIZARD_FIXTURE_DOC))
    backend.files.set(`${FOLDER}/rewrites.json`, JSON.stringify(WIZARD_FIXTURE_REWRITES))
    backend.recent = [{ path: FOLDER, name: 'The Long Night', openedAt: 'a' }]
  }

  it('settings persist through save and reopen; the title is the project title; the last folder is remembered', async () => {
    seed()
    render(<App />)
    await waitFor(() => expect(getEditor()).not.toBeNull())
    await setProfile()
    await open(FOLDER)
    openWizard()
    expect((ctl(C.title.id) as HTMLInputElement).value).toBe('The Long Night')
    act(() => fireEvent.change(ctl(C.genre.id)!, { target: { value: 'thriller' } }))
    alt('Digit2')
    act(() => fireEvent.click(ctl(C.presetClassic.id)!))
    act(() => fireEvent.change(ctl(C.paper.id)!, { target: { value: 'a4' } }))
    alt('Digit4')
    ex.savePath = '/out/Night.docx'
    act(() => fireEvent.click(ctl(C.formatPdf.id)!))
    alt('KeyE')
    await waitFor(() => expect(getWizardState().run.phase).toBe('done'))
    expect(getLastOutputFolder()).toBe('/out')
    closeWizard()
    expect(await act(() => saveProject())).toBe(true)
    const saved = JSON.parse(backend.files.get(`${FOLDER}/export.json`)!)
    expect(saved.settings).toMatchObject({ preset: 'classic', paper: 'a4', fontFamily: 'Courier New', checks: { genre: 'thriller' }, outputs: { docx: true, pdf: false } })
    // No machine path in the project folder.
    expect(JSON.stringify(saved)).not.toMatch(/\/out/)
    __resetExportSettingsForTests()
    await open(FOLDER)
    expect(getManuscriptSettings()).toMatchObject({ preset: 'classic', paper: 'a4', checks: { genre: 'thriller' } })
    // The next Save dialog opens in the last folder.
    openWizard()
    alt('Digit4')
    alt('KeyE')
    await waitFor(() => expect(getWizardState().run.phase).toBe('done'))
    expect(ex.dialogs.at(-1)!.directory).toBe('/out')
  })

  it('a title typed in the wizard is saved as the project title (Book details)', async () => {
    seed()
    render(<App />)
    await waitFor(() => expect(getEditor()).not.toBeNull())
    await setProfile()
    await open(FOLDER)
    openWizard()
    await typeInto(C.title.id, 'The Longest Night')
    alt('KeyN')
    await waitFor(() => expect(useStore.getState().project.title).toBe('The Longest Night'))
    expect(JSON.parse(backend.files.get(`${FOLDER}/project.json`)!).title).toBe('The Longest Night')
  })

  it('useLastOutputFolder follows a project switch', async () => {
    seed()
    backend.dirs.add('/books/other')
    backend.files.set('/books/other/project.json', JSON.stringify({ format: 'novel-project', schemaVersion: 1, id: 'other-id', title: 'Other', createdAt: 'a', updatedAt: 'b' }))
    backend.files.set('/books/other/manuscript.json', JSON.stringify({ type: 'doc', content: [{ type: 'paragraph' }] }))
    backend.recent = [...backend.recent, { path: '/books/other', name: 'Other', openedAt: 'b' }]
    act(() => useStore.getState().preferencesActions.set('exportFolders', { 'night-id': '/out/night', 'other-id': '/out/other' }))
    const seen: (string | null)[] = []
    function Probe() {
      seen.push(useLastOutputFolder())
      return null
    }
    render(
      <>
        <App />
        <Probe />
      </>,
    )
    await waitFor(() => expect(getEditor()).not.toBeNull())
    await open(FOLDER)
    await waitFor(() => expect(seen.at(-1)).toBe('/out/night'))
    await open('/books/other')
    await waitFor(() => expect(seen.at(-1)).toBe('/out/other'))
  })
})
