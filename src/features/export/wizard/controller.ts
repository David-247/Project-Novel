import { useSyncExternalStore } from 'react'
import { TextSelection } from '@tiptap/pm/state'
import { getChapters, getEditor, getResolvedStyles } from '@/features/editor'
import { revealPosition } from '@/features/pagination'
import { askConfirm, getCurrentProjectPath, updateProjectDetails } from '@/features/storage'
import { getCommand, notifyCommandStateChanged, runCommand } from '@/shared/commands'
import { useStore } from '@/shared/store'
import { buildManuscript, type ManuscriptIR } from '../ir'
import { pickSavePath, type SaveTarget } from '../platform'
import { getContactOverride, getLastOutputFolder, getManuscriptSettings, getResolvedContact, setLastOutputFolder, updateManuscriptSettings } from '../settings'
import type { ManuscriptSettings } from '../settings'
import { manuscriptWordCount, normalizeSentenceSpaces } from './analysis'
import { locateInDoc, type DocLocations } from './locate'
import { hasBlocking, runChecks, type CheckAction, type CheckResult, type WizardField } from './checks'
import { getExportRenderer, type ExportJob, type WizardFormat, WIZARD_FORMATS } from './renderers'
import { describeExportError, ExportRunError, runExport, type WrittenFile } from './run'
import { fileNameOf, folderOf, manuscriptFileName, titlePageData } from './title-page'

/**
 * The export wizard's state and actions (module state: one window, one wizard). The dialog
 * (ExportWizard.tsx) renders it; the commands (File > Export) and the status bar's export notice call
 * the actions. Nothing here changes the manuscript.
 */

export const WIZARD_STEPS = ['title', 'format', 'checks', 'export'] as const
export type WizardStep = (typeof WIZARD_STEPS)[number]

export type RunPhase = 'ready' | 'choosing' | 'rendering' | 'saving' | 'done' | 'error' | 'cancelled'

export interface RunState {
  phase: RunPhase
  /** Where the run started: the wizard's Export step, or Export Manuscript Again (status bar). */
  origin: 'wizard' | 'again'
  /** 0 to 1. */
  progress: number
  /** The format being rendered or saved. */
  format: WizardFormat | null
  error: ExportRunError | null
  written: WrittenFile[]
}

interface WizardState {
  open: boolean
  step: WizardStep
  /** A field to focus once its step shows (a check's Fix action), with a bump so the same field refocuses. */
  focus: { field: WizardField; seq: number } | null
  /** The title being typed, until it is saved to the project (null: the project's title). */
  titleDraft: string | null
  /** The contact fields edit this project's override (else the app author profile). */
  overrideContact: boolean
  run: RunState
}

const IDLE_RUN: RunState = { phase: 'ready', origin: 'wizard', progress: 0, format: null, error: null, written: [] }

let state: WizardState = { open: false, step: 'title', focus: null, titleDraft: null, overrideContact: false, run: IDLE_RUN }
/** The title for a manuscript with no project open (nothing to save it to). */
let unsavedTitle = ''
/** Where focus was when the wizard opened: given back on Cancel / close. */
let returnFocusTo: HTMLElement | null = null
/** The wizard closed for a Show me / Fix action: reopening it returns to the Checks step. */
let resumeAtChecks = false
let controller: AbortController | null = null
let focusSeq = 0

/** The last successful export of this project in this session (Export Manuscript Again repeats it). */
interface LastExport {
  projectPath: string | null
  formats: WizardFormat[]
  targets: Partial<Record<WizardFormat, SaveTarget>>
}
let lastExport: LastExport | null = null

const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())
function update(patch: Partial<WizardState>): void {
  state = { ...state, ...patch }
  emit()
}
function updateRun(patch: Partial<RunState>): void {
  const phase = state.run.phase
  state = { ...state, run: { ...state.run, ...patch } }
  emit()
  // Export Manuscript Again is disabled while an export runs.
  if (state.run.phase !== phase) notifyCommandStateChanged()
}
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}
const snapshot = () => state

export const getWizardState = (): WizardState => state
export const useWizardState = (): WizardState => useSyncExternalStore(subscribe, snapshot, snapshot)

// ---- the manuscript ------------------------------------------------------------------------------

/** The title the export uses: the one being typed, the project's, or the one typed without a project. */
export function getManuscriptTitle(): string {
  if (state.titleDraft !== null) return state.titleDraft
  const project = useStore.getState().project
  return project.path ? (project.title ?? '') : unsavedTitle
}

export function setTitleDraft(title: string): void {
  if (!getCurrentProjectPath()) unsavedTitle = title
  update({ titleDraft: title })
}

/** Save the typed title to the project (Book details). A blank title is not saved (the project keeps its own). */
export async function commitTitle(): Promise<void> {
  const draft = state.titleDraft
  if (draft === null) return
  if (!getCurrentProjectPath()) {
    unsavedTitle = draft
    update({ titleDraft: null })
    return
  }
  if (!draft.trim()) return
  const ok = await updateProjectDetails({ title: draft })
  if (ok && state.titleDraft === draft) update({ titleDraft: null })
}

export interface PreparedManuscript {
  ir: ManuscriptIR
  wordCount: number
  /** Where the checks' Show me actions go in the manuscript (document positions). */
  locations: DocLocations
}

/**
 * The manuscript IR of the open document (pending changes accepted), with the wizard's build options.
 * Null when no manuscript is mounted.
 */
export function prepareManuscript(settings: ManuscriptSettings = getManuscriptSettings()): PreparedManuscript | null {
  const ed = getEditor()
  if (!ed) return null
  const s = useStore.getState()
  const openRewriteAnchors = s.rewrite.rewrites.filter((r) => r.status === 'open').map((r) => r.anchor)
  const ir = buildManuscript(ed.state.doc, getResolvedStyles(), {
    footnotes: s.book.footnotes,
    openRewriteAnchors,
    blankLineSceneBreaks: settings.checks.blankLineSceneBreaks,
  })
  return { ir, wordCount: manuscriptWordCount(ir).total, locations: locateInDoc(ed.state.doc) }
}

/** The checks for a prepared manuscript with the current title, contact and settings. */
export function checksFor(prepared: PreparedManuscript, settings: ManuscriptSettings = getManuscriptSettings()): CheckResult[] {
  return runChecks({ ir: prepared.ir, settings, title: getManuscriptTitle(), contact: getResolvedContact(), wordCount: prepared.wordCount, locations: prepared.locations })
}

/** The job an export renders: the IR with the export-only options applied, the settings, the title page. */
export function exportJob(prepared: PreparedManuscript, settings: ManuscriptSettings = getManuscriptSettings()): ExportJob {
  const ir = settings.checks.normalizeSpaces ? normalizeSentenceSpaces(prepared.ir) : prepared.ir
  return { ir, settings, titlePage: titlePageData(settings, getResolvedContact(), getManuscriptTitle(), prepared.wordCount) }
}

/** The formats the settings ask for that this build can make. */
export function chosenFormats(settings: ManuscriptSettings = getManuscriptSettings()): WizardFormat[] {
  return WIZARD_FORMATS.filter((f) => settings.outputs[f] && getExportRenderer(f))
}

// ---- opening and closing -------------------------------------------------------------------------

/** File > Export > Manuscript…: open the wizard (at the Checks step after a Show me / Fix action). */
export function openWizard(options: { step?: WizardStep } = {}): void {
  if (state.open) return
  returnFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const step = options.step ?? (resumeAtChecks ? 'checks' : 'title')
  resumeAtChecks = false
  const overrideContact = Object.keys(getContactOverride()).length > 0
  const keepRun = state.run.phase === 'rendering' || state.run.phase === 'saving'
  update({ open: true, step, focus: null, titleDraft: null, overrideContact, run: keepRun ? { ...state.run, origin: 'wizard' } : IDLE_RUN })
}

/**
 * Close the wizard. A running export is cancelled (it writes nothing). `restoreFocus`: give the focus
 * back to where it was (false when a Show me action moves it into the manuscript).
 */
export function closeWizard({ restoreFocus = true }: { restoreFocus?: boolean } = {}): void {
  if (!state.open) return
  if (state.run.phase === 'rendering' || state.run.phase === 'choosing') controller?.abort()
  void commitTitle()
  update({ open: false, focus: null })
  const target = returnFocusTo
  returnFocusTo = null
  if (!restoreFocus) return
  // Back where it was; opened from the ribbon or a menu (which keep no focus) or with nothing focused,
  // back to the manuscript.
  setTimeout(() => {
    if (target && target !== document.body && target.isConnected) target.focus()
    else getEditor()?.view.focus()
  }, 0)
}

export function setStep(step: WizardStep): void {
  if (state.step === step) return
  void commitTitle()
  update({ step, focus: null })
}

export function stepBy(delta: 1 | -1): void {
  const i = WIZARD_STEPS.indexOf(state.step) + delta
  if (i >= 0 && i < WIZARD_STEPS.length) setStep(WIZARD_STEPS[i])
}

export function setOverrideContact(on: boolean): void {
  update({ overrideContact: on })
}

const FIELD_STEP: Record<WizardField, WizardStep> = {
  title: 'title',
  legalName: 'title',
  penName: 'title',
  address: 'title',
  phone: 'title',
  email: 'title',
  genre: 'title',
}

/** Go to the step holding `field` and focus it. */
export function focusField(field: WizardField): void {
  update({ step: FIELD_STEP[field], focus: { field, seq: ++focusSeq } })
}

// ---- check actions -------------------------------------------------------------------------------

/** After the wizard's dialog is gone (its focus return and scroll lock undone). */
const afterClose = (fn: () => void) => setTimeout(() => requestAnimationFrame(fn), 0)

/** Close the wizard, then put the caret at document position `pos` (or select `pos..to`) and show it. */
export function showPosition(pos: number, to?: number): boolean {
  const ed = getEditor()
  if (!ed || pos < 0 || pos > ed.state.doc.content.size) return false
  resumeAtChecks = true
  closeWizard({ restoreFocus: false })
  afterClose(() => {
    const view = getEditor()?.view
    if (!view) return
    const doc = view.state.doc
    const from = Math.min(pos, doc.content.size)
    const sel = to !== undefined && to > from && to <= doc.content.size ? TextSelection.create(doc, from, to) : TextSelection.near(doc.resolve(from))
    view.dispatch(view.state.tr.setSelection(sel).scrollIntoView())
    view.focus()
    revealPosition(sel.from)
  })
  return true
}

/**
 * Put the caret at the start of chapter `index` (the No Markup chapters, as the IR counts them) and
 * show it; -1 is the front matter (the start of the manuscript).
 */
export function showChapter(index: number): boolean {
  const ed = getEditor()
  if (!ed) return false
  if (index < 0) return showPosition(0)
  const chapter = getChapters(ed.state.doc, getResolvedStyles(), 'none').find((c) => c.index === index)
  if (!chapter) return false
  return showPosition(chapter.from + 1)
}

/** Close the wizard and run a review command (Next Change, the comments panel, Next Re-write). */
function closeAndRun(ids: readonly string[]): void {
  resumeAtChecks = true
  closeWizard({ restoreFocus: false })
  afterClose(() => {
    for (const id of ids) runCommand(id)
  })
}

export function runCheckAction(action: CheckAction): void {
  switch (action.kind) {
    case 'fix':
      return focusField(action.field)
    case 'show-chapter':
      showChapter(action.chapter)
      return
    case 'show-position':
      showPosition(action.pos, action.to)
      return
    case 'option': {
      const checks = getManuscriptSettings().checks
      updateManuscriptSettings({ checks: action.option === 'normalizeSpaces' ? { ...checks, normalizeSpaces: true } : { ...checks, blankLineSceneBreaks: 'off' } })
      return
    }
    case 'review-changes':
      return closeAndRun(['review.change.next'])
    case 'show-comments': {
      const panel = getCommand('comment.panel')
      return closeAndRun(panel?.isChecked?.() ? ['comment.next'] : ['comment.panel', 'comment.next'])
    }
    case 'open-rewrite':
      return closeAndRun(['rewrite.next'])
  }
}

// ---- exporting -----------------------------------------------------------------------------------

const busy = () => ['choosing', 'rendering', 'saving'].includes(state.run.phase)

/**
 * Ask where to save each format (one Save dialog each). Rust opens each dialog in the folder of the
 * last grant (so the second starts where the first was saved), else where this project's last export
 * went. Null when the user cancelled; a failing dialog rejects (an ExportRunError).
 */
async function chooseTargets(job: ExportJob, formats: readonly WizardFormat[], title: string): Promise<Partial<Record<WizardFormat, SaveTarget>> | null> {
  const targets: Partial<Record<WizardFormat, SaveTarget>> = {}
  for (const format of formats) {
    let picked: SaveTarget | null
    try {
      picked = await pickSavePath(format, manuscriptFileName(job.titlePage, format), title)
    } catch (e) {
      throw describeExportError(e, format, 'save')
    }
    if (!picked) return null
    targets[format] = picked
  }
  return targets
}

/**
 * Ask where to save; on a failing Save dialog show the error (the run's error state, with Retry and
 * Choose another location) and resolve null, as for a cancel.
 */
async function chooseTargetsOrShow(job: ExportJob, formats: readonly WizardFormat[], title: string, origin: RunState['origin']) {
  try {
    return { targets: await chooseTargets(job, formats, title), failed: false }
  } catch (e) {
    lastAttempt = { job, formats: [...formats], targets: {}, origin }
    updateRun({ phase: 'error', origin, error: describeExportError(e, formats[0] ?? 'docx', 'save') })
    return { targets: null, failed: true }
  }
}

async function run(job: ExportJob, formats: WizardFormat[], targets: Partial<Record<WizardFormat, SaveTarget>>, origin: RunState['origin']): Promise<boolean> {
  controller?.abort()
  const ctl = new AbortController()
  controller = ctl
  const renderers = Object.fromEntries(formats.map((f) => [f, getExportRenderer(f)]))
  updateRun({ phase: 'rendering', origin, progress: 0, format: formats[0] ?? null, error: null, written: [] })
  lastAttempt = { job, formats, targets, origin }
  try {
    const written = await runExport(job, formats, targets, renderers, {
      signal: ctl.signal,
      onProgress: (p) => {
        if (controller !== ctl) return
        updateRun({ progress: p.fraction, format: p.format, phase: p.stage === 'save' ? 'saving' : 'rendering' })
      },
    })
    if (controller !== ctl) return false
    controller = null
    updateRun({ phase: 'done', progress: 1, written, error: null })
    const folder = written.length ? folderOf(written[0].path) : null
    if (folder) setLastOutputFolder(folder)
    lastExport = { projectPath: getCurrentProjectPath(), formats, targets }
    notifyCommandStateChanged()
    return true
  } catch (e) {
    if (controller !== ctl) return false
    controller = null
    const err = describeExportError(e, formats[0] ?? 'docx', 'render')
    updateRun({ phase: err.problem === 'cancelled' ? 'cancelled' : 'error', error: err })
    return false
  }
}

/** What the last run was given, for Retry. */
let lastAttempt: { job: ExportJob; formats: WizardFormat[]; targets: Partial<Record<WizardFormat, SaveTarget>>; origin: RunState['origin'] } | null = null

/**
 * The wizard's Export: ask where to save each chosen format, then render and save them. False when
 * the user cancelled a Save dialog, the export failed, or a blocking check is open.
 */
export async function startExport(): Promise<boolean> {
  if (busy()) return false
  const settings = getManuscriptSettings()
  const prepared = prepareManuscript(settings)
  if (!prepared) return false
  if (hasBlocking(checksFor(prepared, settings))) return false
  const formats = chosenFormats(settings)
  if (!formats.length) return false
  await commitTitle()
  const job = exportJob(prepared, settings)
  updateRun({ phase: 'choosing', origin: 'wizard', error: null, written: [], progress: 0 })
  const { targets, failed } = await chooseTargetsOrShow(job, formats, 'Export Manuscript', 'wizard')
  if (failed) return false
  if (!targets) {
    updateRun({ phase: 'ready' })
    return false
  }
  return run(job, formats, targets, 'wizard')
}

/** Export again to the same files after an error (same job and targets; asks where when it had none). */
export async function retryExport(): Promise<boolean> {
  if (busy() || !lastAttempt) return false
  const { job, formats, targets, origin } = lastAttempt
  if (!formats.every((f) => targets[f])) return chooseOtherLocation()
  return run(job, formats, targets, origin)
}

/**
 * After an error: choose other places to save, then export the same job. Cancelling the Save dialog
 * puts the error (and its Retry) back.
 */
export async function chooseOtherLocation(): Promise<boolean> {
  if (busy() || !lastAttempt) return false
  const { job, formats, origin } = lastAttempt
  const previous = state.run.error
  updateRun({ phase: 'choosing', origin, error: null })
  const { targets, failed } = await chooseTargetsOrShow(job, formats, origin === 'again' ? 'Export Manuscript Again' : 'Export Manuscript', origin)
  if (failed) return false
  if (!targets) {
    updateRun(previous ? { phase: 'error', error: previous } : origin === 'again' ? { ...IDLE_RUN } : { phase: 'ready' })
    return false
  }
  return run(job, formats, targets, origin)
}

/** Cancel the running export (nothing is written). */
export function cancelExport(): void {
  if (state.run.phase === 'saving') return
  controller?.abort()
}

/** The status bar's notice of an Export Again run is dismissed. */
export function dismissRun(): void {
  if (busy()) return
  updateRun({ ...IDLE_RUN })
}

/** Can Export Manuscript Again run (a manuscript, and an export of this project before, or its folder)? */
export function canExportAgain(): boolean {
  if (!getEditor() || busy()) return false
  const sameProject = lastExport && lastExport.projectPath === getCurrentProjectPath()
  return Boolean(sameProject || getLastOutputFolder())
}

/**
 * File > Export > Export Manuscript Again: the last export with the current settings and the same
 * files, after asking to replace them; without the wizard (progress in the status bar). After a
 * restart (Save-dialog grants are per session) the Save dialog asks, starting in the last folder.
 * A blocking check opens the wizard at its Checks step instead.
 */
/** Export Again is between its command and its run (the confirm question, the Save dialogs). */
let againPending = false

export async function exportAgain(): Promise<boolean> {
  // A second Export Again (its shortcut pressed twice) while the first one asks is ignored.
  if (state.open || busy() || againPending) return false
  againPending = true
  try {
    return await exportAgainUnguarded()
  } finally {
    againPending = false
  }
}

async function exportAgainUnguarded(): Promise<boolean> {
  const settings = getManuscriptSettings()
  const prepared = prepareManuscript(settings)
  if (!prepared) return false
  if (hasBlocking(checksFor(prepared, settings))) {
    openWizard({ step: 'checks' })
    return false
  }
  const sameProject = lastExport && lastExport.projectPath === getCurrentProjectPath() ? lastExport : null
  const formats = (sameProject?.formats ?? chosenFormats(settings)).filter((f) => getExportRenderer(f))
  if (!formats.length) {
    openWizard({ step: 'export' })
    return false
  }
  const job = exportJob(prepared, settings)
  let targets = sameProject && formats.every((f) => sameProject.targets[f]) ? sameProject.targets : null
  if (targets) {
    const names = formats.map((f) => fileNameOf(targets![f]!.path)).join(' and ')
    const ok = await askConfirm('Export Manuscript Again', `Replace ${names} with the manuscript as it is now?`, 'Replace')
    if (!ok) return false
  } else {
    updateRun({ phase: 'choosing', origin: 'again', error: null, written: [], progress: 0 })
    const chosen = await chooseTargetsOrShow(job, formats, 'Export Manuscript Again', 'again')
    if (chosen.failed) return false
    targets = chosen.targets
    if (!targets) {
      updateRun({ ...IDLE_RUN })
      return false
    }
  }
  const ok = await run(job, formats, targets, 'again')
  // The grants were forgotten (Rust keeps the last 16): ask where, then try once more.
  if (!ok && state.run.error?.problem === 'not-granted') return chooseOtherLocation()
  return ok
}

/** Test-only. */
export function __resetWizardForTests(): void {
  controller?.abort()
  controller = null
  lastExport = null
  lastAttempt = null
  againPending = false
  unsavedTitle = ''
  resumeAtChecks = false
  returnFocusTo = null
  state = { open: false, step: 'title', focus: null, titleDraft: null, overrideContact: false, run: IDLE_RUN }
  emit()
}
