import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { getEditor, getChapters, getResolvedStyles, setDocJSON } from '@/features/editor'
import {
  __resetExportRenderersForTests,
  __resetExportSettingsForTests,
  __resetWizardForTests,
  createManuscriptExportRenderers,
  createMockExportRenderers,
  EXPORT_COMMAND_IDS,
  EXPORT_WIZARD_CONTROLS as C,
  getLastOutputFolder,
  getManuscriptSettings,
  getWizardState,
  setExportRenderers,
  updateManuscriptSettings,
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
vi.mock('@tauri-apps/api/app', () => ({ getVersion: async () => '0.4.0' }))

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
  // App registers the real DOCX / PDF generators (e2e and generators.test.ts cover them); these tests
  // read the mock's plain-text output, so the mock goes back on top.
  offRenderers()
  offRenderers = setExportRenderers(createMockExportRenderers())
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

  it('on macOS, Option+letter in a text field types its character: no access key runs (B-I1)', async () => {
    const platform = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
    try {
      await renderApp()
      openWizard()
      const legal = ctl(C.legalName.id) as HTMLInputElement
      act(() => legal.focus())
      // "Søren": Option+O types "ø"; it must not toggle "Use other details for this project".
      let typed = true
      act(() => {
        typed = fireEvent.keyDown(legal, { key: 'ø', code: 'KeyO', altKey: true })
      })
      expect(typed).toBe(true)
      expect(getWizardState().overrideContact).toBe(false)
      expect(document.activeElement).toBe(legal)
      // "Peña": Option+N (the dead key) does not jump to Formatting; nor Option+2 (™) to step 2.
      act(() => void fireEvent.keyDown(legal, { key: 'Dead', code: 'KeyN', altKey: true }))
      act(() => void fireEvent.keyDown(legal, { key: '™', code: 'Digit2', altKey: true }))
      expect(getWizardState().step).toBe('title')
      // The address (a textarea) is a text field too.
      const address = ctl(C.address.id) as HTMLTextAreaElement
      act(() => address.focus())
      act(() => void fireEvent.keyDown(address, { key: 'ß', code: 'KeyS', altKey: true }))
      expect(getManuscriptSettings().titlePage.showAgent).toBe(false)
      // Off a text field (the genre list) the access keys still work.
      act(() => ctl(C.genre.id)!.focus())
      alt('KeyN')
      expect(getWizardState().step).toBe('format')
    } finally {
      platform.mockRestore()
    }
  })

  it('on Windows, Alt+letter in a text field is the access key (Word)', async () => {
    const platform = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32')
    try {
      await renderApp()
      openWizard()
      const legal = ctl(C.legalName.id) as HTMLInputElement
      act(() => legal.focus())
      alt('KeyN')
      expect(getWizardState().step).toBe('format')
    } finally {
      platform.mockRestore()
    }
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
    const ed = getEditor()!
    const untitled = getChapters(ed.state.doc, getResolvedStyles(), 'none').find((c) => c.index === 2)!
    // After the dialog is gone (a task and a frame).
    await waitFor(() => expect(ed.state.selection.from).toBe(untitled.from + 1))
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
      await waitFor(after)
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

describe('final-review minors (B-M1, B-M2, B-M3)', () => {
  it('B-M1: closing the wizard while it saves finishes in the status bar, which says the files were written', async () => {
    await renderApp()
    openWizard()
    alt('Digit4')
    const handle = core.handle
    let closed = false
    const spy = vi.spyOn(core, 'handle').mockImplementation(async (cmd, args, options) => {
      if (cmd === 'export_write_file' && !closed) {
        closed = true
        expect(getWizardState().run.phase).toBe('saving')
        act(() => closeWizard())
      }
      return handle(cmd, args, options)
    })
    try {
      alt('KeyE')
      await waitFor(() => expect(getWizardState().run.phase).toBe('done'))
    } finally {
      spy.mockRestore()
    }
    expect(closed).toBe(true)
    expect(dialog()).toBeNull()
    expect([...ex.written.keys()]).toEqual([DOCX, PDF])
    await waitFor(() => expect(document.querySelector('[data-testid="export-status"]')!.textContent).toMatch(/Exported Waight_THE_LONG_NIGHT_manuscript\.docx and/))
  })

  it('B-M2: a cleared title stays cleared (no snap back to a deleted letter) and shows Required', async () => {
    await renderApp('')
    openWizard()
    const field = ctl(C.title.id) as HTMLInputElement
    act(() => {
      field.focus()
      fireEvent.change(field, { target: { value: 'A' } })
    })
    act(() => fireEvent.change(field, { target: { value: '' } }))
    expect(dialog()!.textContent).toContain('Required: the title page and the header need it.')
    act(() => fireEvent.blur(field))
    expect(field.value).toBe('')
    expect(getWizardState().titleDraft).toBe('')
  })

  it('B-M3: after a project opens and closes, the new untitled manuscript has neither the old title nor its last export', async () => {
    await renderApp()
    openWizard()
    alt('Digit4')
    alt('KeyE')
    await waitFor(() => expect(getWizardState().run.phase).toBe('done'))
    closeWizard()
    const again = getCommand(EXPORT_COMMAND_IDS.again)!
    expect(isCommandEnabled(again)).toBe(true)
    act(() => {
      useStore.getState().projectActions.projectOpened({ path: '/projects/Other', title: 'Other' })
      useStore.getState().projectActions.projectClosed()
    })
    expect(isCommandEnabled(again)).toBe(false)
    ex.written.clear()
    await act(async () => again.run())
    await flush()
    // No "Replace Waight_THE_LONG_NIGHT_manuscript.docx…?" and nothing overwritten.
    expect(backend.messages.map((m) => m.text).filter((t) => t.startsWith('Replace'))).toEqual([])
    expect(ex.written.size).toBe(0)
    // The untitled manuscript has no title: Export Again opens the wizard at Checks (Must fix: the title).
    expect(getWizardState().step).toBe('checks')
    expect(checkEl('title')).toHaveAttribute('data-severity', 'blocking')
    alt('Digit1')
    expect((ctl(C.title.id) as HTMLInputElement).value).toBe('')
  })
})

describe('the front matter title block (Wave 2 ruling)', () => {
  const docxText = () => new TextDecoder().decode(ex.written.get('/exports/Waight_THE_LONG_NIGHT_manuscript.docx'))

  it('with the generated title page, THE LONG NIGHT / A novel do not print again; without it, they do', async () => {
    await renderApp()
    await exportOnce()
    expect(docxText()).not.toContain('THE LONG NIGHT')
    expect(docxText()).not.toMatch(/^A novel$/m)
    expect(docxText()).toContain('For M.')
    act(() => updateManuscriptSettings({ titlePage: { ...getManuscriptSettings().titlePage, include: false } }))
    ex.written.clear()
    await exportOnce()
    expect(docxText()).toContain('THE LONG NIGHT')
    expect(docxText()).toContain('For M.')
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

  it('the font the PDF is really set in: "Garamond" is set in Times New Roman, and the wizard says so (B-I2)', async () => {
    backend.fonts = ['Garamond', 'Times New Roman']
    await renderApp()
    // The real PDF generator (its Typst render is the fake core's), PDF only.
    offRenderers()
    __resetExportRenderersForTests()
    const reports: string[] = []
    offRenderers = setExportRenderers({ pdf: createManuscriptExportRenderers({ pdf: { onReport: (r) => reports.push(r.font.family) } }).pdf })
    act(() => updateManuscriptSettings({ fontFamily: 'Garamond' }))
    openWizard()
    alt('Digit2')
    const note = dialog()!.querySelector('[data-testid="font-note"]')!.textContent!
    expect(note).not.toMatch(/names and the PDF is set in/)
    expect(note).toMatch(/^The PDF is set in (Times New Roman|Liberation Serif)/)
    expect(note).toMatch(/Garamond applies to the Word file only/)
    alt('Digit4')
    alt('KeyE')
    await waitFor(() => expect(dialog()!.querySelector('[data-testid="export-done"]')).not.toBeNull())
    expect(reports).toEqual(['Times New Roman'])
    expect(dialog()!.querySelector('[data-testid="export-font-note"]')!.textContent).toBe(
      'The PDF is set in Times New Roman, not Garamond: the PDF can use only Times New Roman or Courier New. The Word file names Garamond.',
    )
  })

  it('the PDF set in the bundled Liberation Serif (no Times New Roman installed) is named on the success screen', async () => {
    backend.fonts = ['Arial']
    await renderApp()
    offRenderers()
    __resetExportRenderersForTests()
    offRenderers = setExportRenderers({ pdf: createManuscriptExportRenderers().pdf })
    openWizard()
    alt('Digit4')
    alt('KeyE')
    await waitFor(() => expect(dialog()!.querySelector('[data-testid="export-done"]')).not.toBeNull())
    expect(dialog()!.querySelector('[data-testid="export-font-note"]')!.textContent).toMatch(/^The PDF is set in Liberation Serif, a free font bundled with Novel/)
  })

  it('only the formats chosen; a format with no renderer cannot be chosen', async () => {
    await renderApp()
    offRenderers()
    // Drop App's real renderers too: this build has a DOCX renderer only.
    __resetExportRenderersForTests()
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

const DOCX = '/exports/Waight_THE_LONG_NIGHT_manuscript.docx'
const PDF = '/exports/Waight_THE_LONG_NIGHT_manuscript.pdf'
const status = () => document.querySelector<HTMLElement>('[data-testid="export-status"]')
const confirms = () => backend.messages.filter((m) => m.text.startsWith('Replace ')).length

/** Export both formats through the wizard and close it. */
async function exportOnce() {
  openWizard()
  alt('Digit4')
  alt('KeyE')
  await waitFor(() => expect(getWizardState().run.phase).toBe('done'))
  closeWizard()
}

describe('Show me on every check that finds something (fix round 1)', () => {
  it('a scene break: the caret goes to its chapter', async () => {
    await renderApp()
    openWizard()
    alt('Digit3')
    const rows = checkEl('scene-breaks')!.querySelectorAll<HTMLElement>(`[data-control-id="${C.checkShowChapter.id}"]`)
    expect(Array.from(rows, (r) => r.getAttribute('aria-label'))).toEqual([
      'Show me: "* * *" in Chapter One · The Arrival',
      'Show me: A blank line in The Storm',
      'Show me: "#" in The Storm',
    ])
    act(() => fireEvent.click(rows[1]))
    expect(dialog()).toBeNull()
    const ed = getEditor()!
    const storm = getChapters(ed.state.doc, getResolvedStyles(), 'none').find((c) => c.index === 1)!
    await waitFor(() => expect(ed.state.selection.from).toBe(storm.from + 1))
  })

  it('double spaces: Show me selects the first two spaces after a full stop', async () => {
    await renderApp()
    openWizard()
    alt('Digit3')
    act(() => fireEvent.click(checkEl('double-spaces')!.querySelector(`[data-control-id="${C.checkShowText.id}"]`)!))
    const ed = getEditor()!
    await waitFor(() => expect(ed.state.selection.empty).toBe(false))
    const { from, to } = ed.state.selection
    expect(ed.state.doc.textBetween(from - 'waited.'.length, to + 'Nobody'.length)).toBe('waited.  Nobody')
  })

  it('book formatting: Show me puts the caret at the first formatting left out (the run in Georgia)', async () => {
    await renderApp()
    openWizard()
    alt('Digit3')
    act(() => fireEvent.click(checkEl('formatting')!.querySelector(`[data-control-id="${C.checkShowText.id}"]`)!))
    const ed = getEditor()!
    await waitFor(() => expect(ed.state.doc.nodeAt(ed.state.selection.from)?.text).toBe(' and '))
    openWizard()
    expect(getWizardState().step).toBe('checks')
  })
})

describe('error states (fix round 1)', () => {
  it('a Save dialog that fails shows the error with Retry, which asks again', async () => {
    await renderApp()
    ex.failPick = { kind: 'io', message: 'dialog plugin failed', diagnostics: [] }
    openWizard()
    alt('Digit4')
    alt('KeyE')
    await waitFor(() => expect(dialog()!.querySelector('[data-testid="export-error"]')).not.toBeNull())
    expect(dialog()!.querySelector('[data-testid="export-error"]')!.textContent).toMatch(/dialog plugin failed/)
    expect(ex.written.size).toBe(0)
    ex.failPick = null
    act(() => fireEvent.click(ctl(C.retry.id)!))
    await waitFor(() => expect(dialog()!.querySelector('[data-testid="export-done"]')).not.toBeNull())
    expect(ex.written.size).toBe(2)
  })

  it('Choose another location, cancelled, puts the error and its Retry back', async () => {
    await renderApp()
    ex.failWrite = { kind: 'read_only', message: 'read-only volume', diagnostics: [] }
    openWizard()
    alt('Digit4')
    alt('KeyE')
    await waitFor(() => expect(ctl(C.chooseLocation.id)).not.toBeNull())
    ex.savePath = null
    await act(async () => fireEvent.click(ctl(C.chooseLocation.id)!))
    await waitFor(() => expect(getWizardState().run.phase).toBe('error'))
    expect(dialog()!.querySelector('[data-testid="export-error"]')).toHaveAttribute('data-problem', 'permission')
    expect(ctl(C.retry.id)).not.toBeNull()
  })

  it('a write failing after the first file was saved says that file was saved', async () => {
    await renderApp()
    ex.failWrite = { kind: 'disk_full', message: 'full', diagnostics: [] }
    ex.failWriteMatch = '.pdf'
    openWizard()
    alt('Digit4')
    alt('KeyE')
    await waitFor(() => expect(dialog()!.querySelector('[data-testid="export-error"]')).not.toBeNull())
    expect(dialog()!.querySelector('[data-testid="export-error"]')!.textContent).toMatch(/Waight_THE_LONG_NIGHT_manuscript\.docx was saved\./)
    expect([...ex.written.keys()]).toEqual([DOCX])
  })

  it('Open file and Show in folder failures are shown by the file, as an alert', async () => {
    await renderApp()
    openWizard()
    alt('Digit4')
    alt('KeyE')
    await waitFor(() => expect(dialog()!.querySelector('[data-testid="export-done"]')).not.toBeNull())
    // The files were moved after the export (Rust refuses: not an exported file any more).
    ex.written.clear()
    const rows = dialog()!.querySelectorAll('[data-testid="export-done"] li')
    act(() => fireEvent.click(rows[0].querySelector(`[data-control-id="${C.openFile.id}"]`)!))
    await waitFor(() => expect(rows[0].querySelector('[role="alert"]')).not.toBeNull())
    expect(rows[0].querySelector('[role="alert"]')!.textContent).toBe(
      'Novel could not open Waight_THE_LONG_NIGHT_manuscript.docx: it is no longer where it was exported (moved, renamed or deleted).',
    )
    act(() => fireEvent.click(rows[1].querySelector(`[data-control-id="${C.showInFolder.id}"]`)!))
    await waitFor(() => expect(rows[1].querySelector('[role="alert"]')).not.toBeNull())
    expect(rows[1].querySelector('[role="alert"]')!.textContent).toMatch(/could not show Waight_THE_LONG_NIGHT_manuscript\.pdf/)
    expect(ex.opens).toEqual([])
    audit('file action errors')
  })
})

describe('Export Manuscript Again: error states (fix round 1)', () => {
  it('a failed write shows the error in the status bar with Retry; Retry exports', async () => {
    await renderApp()
    await exportOnce()
    ex.written.clear()
    ex.failWrite = { kind: 'disk_full', message: 'full', diagnostics: [] }
    backend.answer = 'Replace'
    await act(async () => getCommand(EXPORT_COMMAND_IDS.again)!.run())
    await waitFor(() => expect(status()?.querySelector('[role="alert"]')?.textContent).toMatch(/Export failed: The disk is full/))
    expect(auditTooltipCoverage(status()!)).toEqual([])
    ex.failWrite = null
    act(() => fireEvent.click(status()!.querySelector(`[data-control-id="${C.statusRetry.id}"]`)!))
    await waitFor(() => expect(status()!.textContent).toMatch(/Exported Waight_THE_LONG_NIGHT_manuscript\.docx/))
    expect(ex.written.size).toBe(2)
  })

  it('Cancel in the status bar stops the export, writing nothing', async () => {
    await renderApp()
    await exportOnce()
    ex.written.clear()
    offRenderers()
    offRenderers = setExportRenderers(createMockExportRenderers({ delayMs: 40 }))
    backend.answer = 'Replace'
    await act(async () => void getCommand(EXPORT_COMMAND_IDS.again)!.run())
    await waitFor(() => expect(status()?.querySelector(`[data-control-id="${C.statusCancel.id}"]`)).not.toBeNull())
    act(() => fireEvent.click(status()!.querySelector(`[data-control-id="${C.statusCancel.id}"]`)!))
    await waitFor(() => expect(status()!.textContent).toMatch(/Export cancelled\. No file was written\./))
    await act(async () => new Promise((r) => setTimeout(r, 300)))
    expect(ex.written.size).toBe(0)
  })

  it('grants Rust has forgotten: it asks where to save, then exports', async () => {
    await renderApp()
    await exportOnce()
    ex.written.clear()
    core.restartExportSession()
    const before = ex.dialogs.length
    backend.answer = 'Replace'
    await act(async () => getCommand(EXPORT_COMMAND_IDS.again)!.run())
    await waitFor(() => expect(ex.written.size).toBe(2))
    expect(ex.dialogs.length).toBe(before + 2)
  })

  it('a second Export Again while the first one asks is ignored (one question)', async () => {
    await renderApp()
    await exportOnce()
    backend.answer = 'Replace'
    const again = getCommand(EXPORT_COMMAND_IDS.again)!
    await act(async () => {
      again.run()
      again.run()
    })
    await waitFor(() => expect(status()?.textContent ?? '').toMatch(/Exported/))
    expect(confirms()).toBe(1)
  })

  it('Show in folder failing in the status bar is shown as an alert', async () => {
    await renderApp()
    await exportOnce()
    backend.answer = 'Replace'
    await act(async () => getCommand(EXPORT_COMMAND_IDS.again)!.run())
    await waitFor(() => expect(status()?.textContent ?? '').toMatch(/Exported/))
    ex.written.clear()
    act(() => fireEvent.click(status()!.querySelector(`[data-control-id="${C.statusShow.id}"]`)!))
    await waitFor(() => expect(status()!.querySelector('[data-testid="file-action-error"]')).not.toBeNull())
    expect(status()!.querySelector('[data-testid="file-action-error"]')).toHaveAttribute('role', 'alert')
  })

  it('a later Export Again to the same path does not bring the old Show in folder alert back', async () => {
    await renderApp()
    await exportOnce()
    backend.answer = 'Replace'
    const again = getCommand(EXPORT_COMMAND_IDS.again)!
    await act(async () => again.run())
    await waitFor(() => expect(status()?.textContent ?? '').toMatch(/Exported/))
    ex.written.clear()
    act(() => fireEvent.click(status()!.querySelector(`[data-control-id="${C.statusShow.id}"]`)!))
    await waitFor(() => expect(status()!.querySelector('[data-testid="file-action-error"]')).not.toBeNull())
    // The same files again: a new run, so no alert, while it runs or once it is done.
    await act(async () => again.run())
    await waitFor(() => expect(ex.written.size).toBe(2))
    await waitFor(() => expect(status()?.textContent ?? '').toMatch(/Exported/))
    expect(status()!.querySelector('[data-testid="file-action-error"]')).toBeNull()
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

  /** A relaunch: Rust forgets its grants, the wizard its session; Rust's export-folders record stays. */
  function relaunch() {
    core.restartExportSession()
    act(() => __resetWizardForTests())
  }

  it('Export Again after a restart: no grants, so the Save dialog asks, opening in the last folder (Rust’s record)', async () => {
    seed()
    render(<App />)
    await waitFor(() => expect(getEditor()).not.toBeNull())
    await setProfile()
    await open(FOLDER)
    await exportOnce()
    relaunch()
    ex.written.clear()
    const again = getCommand(EXPORT_COMMAND_IDS.again)!
    expect(isCommandEnabled(again)).toBe(true)
    await act(async () => again.run())
    await waitFor(() => expect(ex.written.size).toBe(2))
    // No replace question (the OS Save dialog asks about overwriting); both dialogs start in /exports.
    expect(confirms()).toBe(0)
    expect(ex.dialogs.slice(-2).map((d) => d.directory)).toEqual(['/exports', '/exports'])
    expect([...ex.written.keys()]).toEqual([DOCX, PDF])
  })

  it('Export Again after a restart with a failing Save dialog: the error is in the status bar', async () => {
    seed()
    render(<App />)
    await waitFor(() => expect(getEditor()).not.toBeNull())
    await setProfile()
    await open(FOLDER)
    await exportOnce()
    relaunch()
    ex.failPick = { kind: 'io', message: 'dialog plugin failed', diagnostics: [] }
    await act(async () => getCommand(EXPORT_COMMAND_IDS.again)!.run())
    await waitFor(() => expect(status()?.querySelector('[role="alert"]')?.textContent).toMatch(/dialog plugin failed/))
    expect(status()!.querySelector(`[data-control-id="${C.statusRetry.id}"]`)).not.toBeNull()
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
