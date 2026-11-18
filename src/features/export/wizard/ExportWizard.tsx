import * as RadixDialog from '@radix-ui/react-dialog'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { listSystemFonts } from '@/features/editor'
import { PROFILE_MAX, useStore } from '@/shared/store'
import type { PreferenceValues } from '@/shared/store'
import { Button, cn, focusRing, IconButton, Tooltip } from '@/shared/ui'
import type { SelectOption } from '@/shared/ui'
import {
  CONTACT_FIELDS,
  CONTACT_MAX,
  PRESETS,
  setContactOverride,
  setPreset,
  updateManuscriptSettings,
  useLastOutputFolder,
  useManuscriptSettings,
  useResolvedContact,
} from '../settings'
import type { ContactDetails, ManuscriptSettings, PresetId } from '../settings'
import { openExportedFile, revealInFolder } from '../platform'
import { GENRE_OPTIONS, hasBlocking, sortChecks, type CheckAction, type CheckResult, type CheckSeverity, type WizardField } from './checks'
import { countDoubleSpaces } from './analysis'
import { EXPORT_WIZARD_CONTROLS as C, type ExportControlMeta } from './controls'
import {
  cancelExport,
  checksFor,
  chooseOtherLocation,
  closeWizard,
  getManuscriptTitle,
  prepareManuscript,
  retryExport,
  runCheckAction,
  setOverrideContact,
  setStep,
  setTitleDraft,
  startExport,
  stepBy,
  useWizardState,
  WIZARD_STEPS,
  type PreparedManuscript,
  type RunState,
  type WizardStep,
} from './controller'
import { CheckField, DraftField, handleAccessKey, Mn, SelectField } from './fields'
import { ChapterPagePreview, HeaderPreview, TitlePagePreview } from './previews'
import { useExportRenderers, WIZARD_FORMATS, type WizardFormat } from './renderers'
import { fileNameOf, manuscriptFileName, titlePageData, type TitlePageData } from './title-page'

/**
 * File > Export > Manuscript…: a Word-style wizard (a step list on the left, Back / Next / Cancel) that
 * walks through the title page, the formatting, the publisher-standard checks and the export. Every
 * choice is saved with the project (export.json) as it is made; the manuscript is never changed.
 * In a narrow window the step list becomes a stepper above the step.
 */

const STEP_META: Record<WizardStep, ExportControlMeta> = { title: C.stepTitle, format: C.stepFormat, checks: C.stepChecks, export: C.stepExport }

const ROUNDING_OPTIONS: SelectOption[] = [
  { value: 'auto', label: 'Automatic: nearest 100, or 500 from 20,000 words' },
  { value: 'nearest-100', label: 'Nearest 100' },
  { value: 'nearest-500', label: 'Nearest 500' },
  { value: 'nearest-1000', label: 'Nearest 1,000' },
  { value: 'exact', label: 'Exact count' },
]
const PAPER_OPTIONS: SelectOption[] = [
  { value: 'letter', label: 'Letter (8.5 × 11 in)' },
  { value: 'a4', label: 'A4 (210 × 297 mm)' },
]
const END_OPTIONS: SelectOption[] = [
  { value: 'none', label: 'None' },
  { value: 'end', label: 'END' },
  { value: 'the-end', label: 'THE END' },
]
const FORMAT_META: Record<WizardFormat, ExportControlMeta> = { docx: C.formatDocx, pdf: C.formatPdf }
const FORMAT_NAME: Record<WizardFormat, string> = { docx: 'Word file', pdf: 'PDF' }

/** Hosts the export wizard (portal). Render once in the app. */
export function ExportWizard() {
  const w = useWizardState()
  const settings = useManuscriptSettings()
  const contact = useResolvedContact()
  const projectTitle = useStore((s) => s.project.title)
  const projectPath = useStore((s) => s.project.path)
  const contentRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  // The IR is built when the wizard opens and when an option that changes it does (the manuscript
  // cannot change while the modal wizard is open).
  const blank = settings.checks.blankLineSceneBreaks
  const prepared = useMemo(() => (w.open ? prepareManuscript() : null), [w.open, blank]) // eslint-disable-line react-hooks/exhaustive-deps
  const title = w.titleDraft ?? (projectPath ? (projectTitle ?? '') : getManuscriptTitle())
  const checks = useMemo(() => (prepared ? checksFor(prepared, settings) : []), [prepared, settings, contact, title]) // eslint-disable-line react-hooks/exhaustive-deps
  const data = useMemo(() => titlePageData(settings, contact, title, prepared?.wordCount ?? 0), [settings, contact, title, prepared])
  const renderers = useExportRenderers()
  const blocked = hasBlocking(checks)
  const canExport = WIZARD_FORMATS.some((f) => settings.outputs[f] && renderers[f])
  const running = w.run.phase === 'choosing' || w.run.phase === 'rendering' || w.run.phase === 'saving'

  // A step change moves the focus to the step's first control (Word's wizards do); a Fix action to its field.
  const firstStepRender = useRef(true)
  useEffect(() => {
    if (!w.open) {
      firstStepRender.current = true
      return
    }
    if (firstStepRender.current) {
      firstStepRender.current = false
      return
    }
    const id = requestAnimationFrame(() => focusFirst(panelRef.current))
    return () => cancelAnimationFrame(id)
  }, [w.step, w.open])
  useEffect(() => {
    if (!w.focus) return
    const id = requestAnimationFrame(() => panelRef.current?.querySelector<HTMLElement>(`[data-field="${w.focus!.field}"] input, [data-field="${w.focus!.field}"] select, [data-field="${w.focus!.field}"] textarea`)?.focus())
    return () => cancelAnimationFrame(id)
  }, [w.focus])

  const stepIndex = WIZARD_STEPS.indexOf(w.step)
  const last = stepIndex === WIZARD_STEPS.length - 1
  const done = w.run.phase === 'done' && w.run.origin === 'wizard'

  return (
    <RadixDialog.Root open={w.open} onOpenChange={(o) => !o && closeWizard()}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-scrim animate-[nv-fade_120ms_ease-out]" />
        <RadixDialog.Content
          ref={contentRef}
          data-testid="export-wizard"
          aria-describedby={undefined}
          onOpenAutoFocus={(e) => {
            e.preventDefault()
            requestAnimationFrame(() => focusFirst(panelRef.current))
          }}
          // Focus goes back where it was (closeWizard), or into the manuscript after a Show me.
          onCloseAutoFocus={(e) => e.preventDefault()}
          onKeyDown={(e) => {
            if (handleAccessKey(e, contentRef.current)) return
          }}
          className={cn(
            'fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-5xl -translate-x-1/2 -translate-y-1/2 flex-col',
            'rounded-panel border border-border bg-surface-raised text-text shadow-raised outline-none animate-[nv-rise_140ms_ease-out]',
          )}
        >
          <div className="flex items-start gap-3 px-5 pb-2 pt-4">
            <RadixDialog.Title className="min-w-0 flex-1 text-ui-lg font-semibold">Export Manuscript</RadixDialog.Title>
            <RadixDialog.Close asChild>
              <Tooltip>
                <IconButton label={C.close.label} data-control-id={C.close.id} className="-mr-2 -mt-1">
                  <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4">
                    <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                </IconButton>
              </Tooltip>
            </RadixDialog.Close>
          </div>
          <div className="flex min-h-0 flex-1 flex-col md:flex-row">
            <StepList step={w.step} checks={checks} disabled={running} />
            <div ref={panelRef} className="min-h-0 min-w-0 flex-1 overflow-auto px-5 py-3 text-ui" role="group" aria-labelledby={`export-step-${w.step}`}>
              <h3 id={`export-step-${w.step}`} className="mb-3 text-ui font-semibold">
                Step {stepIndex + 1} of {WIZARD_STEPS.length}: {STEP_META[w.step].label}
              </h3>
              {w.step === 'title' ? <TitleStep settings={settings} contact={contact} data={data} title={title} overrideContact={w.overrideContact} /> : null}
              {w.step === 'format' ? <FormatStep settings={settings} data={data} prepared={prepared} /> : null}
              {w.step === 'checks' ? <ChecksStep checks={checks} settings={settings} prepared={prepared} /> : null}
              {w.step === 'export' ? <ExportStep settings={settings} data={data} run={w.run} blocked={blocked} /> : null}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 border-t border-border px-5 pb-4 pt-3">
            <FooterButton meta={done ? C.finish : C.cancel} onClick={() => closeWizard()} />
            <span className="flex-1" />
            <FooterButton meta={C.back} disabled={stepIndex === 0 || running} onClick={() => stepBy(-1)} />
            {last ? (
              <FooterButton
                meta={C.start}
                variant="primary"
                disabled={running || blocked || !canExport}
                onClick={() => void startExport()}
              />
            ) : (
              <FooterButton meta={C.next} variant="primary" disabled={running} onClick={() => stepBy(1)} />
            )}
          </div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}

function focusFirst(panel: HTMLElement | null) {
  const el = panel?.querySelector<HTMLElement>('input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])')
  el?.focus()
}

interface FooterButtonProps {
  meta: ExportControlMeta
  onClick: () => void
  disabled?: boolean
  variant?: 'primary' | 'secondary'
}

/**
 * A footer button. Disabled is `aria-disabled` (still focusable, its tooltip still explains), so a
 * keyboard user can learn why Export is not available yet.
 */
function FooterButton({ meta, onClick, disabled, variant = 'secondary' }: FooterButtonProps) {
  return (
    <Tooltip side="top">
      <Button
        variant={variant}
        data-control-id={meta.id}
        data-mnemonic={meta.mnemonic}
        aria-disabled={disabled || undefined}
        className={cn('min-w-20', disabled && 'cursor-not-allowed opacity-50')}
        onClick={() => {
          if (!disabled) onClick()
        }}
      >
        <Mn text={meta.label} k={meta.mnemonic} />
      </Button>
    </Tooltip>
  )
}

const SEVERITY_LABEL: Record<CheckSeverity, string> = { blocking: 'Must fix', warning: 'Warning', info: 'Note', pass: 'OK' }

function StepList({ step, checks, disabled }: { step: WizardStep; checks: CheckResult[]; disabled: boolean }) {
  const blocking = checks.filter((c) => c.severity === 'blocking').length
  const warnings = checks.filter((c) => c.severity === 'warning').length
  return (
    <nav aria-label="Export steps" className="shrink-0 border-b border-border px-3 py-2 md:w-52 md:border-b-0 md:border-r md:py-3">
      <ol className="flex items-center gap-1 md:flex-col md:items-stretch">
        {WIZARD_STEPS.map((s, i) => {
          const meta = STEP_META[s]
          const current = s === step
          const badge = s === 'checks' && (blocking || warnings) ? (blocking ? `${blocking} to fix` : `${warnings} warning${warnings === 1 ? '' : 's'}`) : null
          return (
            <li key={s} className="flex min-w-0 items-center md:block">
              <Tooltip side="right">
                <button
                  type="button"
                  data-control-id={meta.id}
                  data-mnemonic={meta.mnemonic}
                  aria-current={current ? 'step' : undefined}
                  aria-label={`Step ${i + 1}: ${meta.label}${badge ? `, ${badge}` : ''}`}
                  disabled={disabled && !current}
                  onClick={() => setStep(s)}
                  className={cn(
                    'flex min-h-control w-full min-w-control items-center gap-2 rounded-control px-2 text-left text-ui-sm',
                    'disabled:cursor-not-allowed disabled:opacity-50',
                    current ? 'bg-accent-soft font-semibold text-accent' : 'text-text hover:bg-surface-hover',
                    focusRing,
                  )}
                >
                  <span aria-hidden="true" className={cn('flex size-6 shrink-0 items-center justify-center rounded-full border text-ui-xs', current ? 'border-accent' : 'border-border-control')}>
                    {i + 1}
                  </span>
                  {/* The label shows beside the current step only in a narrow window (the stepper). */}
                  <span className={cn('min-w-0 truncate', current ? 'inline' : 'hidden md:inline')}>{meta.label}</span>
                  {badge ? <span className="ml-auto hidden text-ui-xs text-text-muted md:inline">{badge}</span> : null}
                </button>
              </Tooltip>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

// ---- 1. Title page ---------------------------------------------------------------------------------

const PROFILE_KEY: Record<keyof ContactDetails, keyof PreferenceValues> = {
  legalName: 'profileLegalName',
  penName: 'profilePenName',
  address: 'profileAddress',
  phone: 'profilePhone',
  email: 'profileEmail',
  agent: 'profileAgent',
}

const CONTACT_META: Record<keyof ContactDetails, ExportControlMeta> = {
  legalName: C.legalName,
  penName: C.penName,
  address: C.address,
  phone: C.phone,
  email: C.email,
  agent: C.agent,
}

function setContactField(field: keyof ContactDetails, value: string, override: boolean) {
  if (override) setContactOverride({ [field]: value })
  else {
    const key = PROFILE_KEY[field] as keyof typeof PROFILE_MAX
    useStore.getState().preferencesActions.set(key, value.slice(0, PROFILE_MAX[key]))
  }
}

interface TitleStepProps {
  settings: ManuscriptSettings
  contact: ContactDetails
  data: TitlePageData
  title: string
  overrideContact: boolean
}

function TitleStep({ settings, contact, data, title, overrideContact }: TitleStepProps) {
  const contactField = (field: keyof ContactDetails, extra: { multiline?: boolean; type?: string; autoComplete?: string; className?: string } = {}) => (
    <div data-field={field} className={extra.className}>
      <DraftField
        meta={CONTACT_META[field]}
        value={contact[field]}
        allowBlank
        maxLength={CONTACT_MAX[field]}
        multiline={extra.multiline}
        type={extra.type}
        autoComplete={extra.autoComplete}
        onCommit={(v) => setContactField(field, v, overrideContact)}
      />
    </div>
  )
  const rounding = settings.wordCountRounding
  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_auto]">
      <div className="flex min-w-0 flex-col gap-4">
        <div data-field="title">
          <DraftField meta={C.title} value={title} invalid={!title.trim()} maxLength={200} onCommit={setTitleDraft} hint={!title.trim() ? 'Required: the title page and the header need it.' : undefined} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {contactField('legalName', { autoComplete: 'name' })}
          {contactField('penName')}
        </div>
        <fieldset className="flex min-w-0 flex-col gap-3 rounded-control border border-border p-3">
          <legend className="px-1 text-ui-sm font-semibold">Contact block</legend>
          <CheckField
            meta={C.overrideContact}
            checked={overrideContact}
            onChange={(on) => {
              setOverrideContact(on)
              // Off: the project's own details are removed; the author profile applies again.
              if (!on) setContactOverride(Object.fromEntries(CONTACT_FIELDS.map((k) => [k, ''])))
            }}
          />
          <p className="text-ui-xs text-text-muted">
            {overrideContact
              ? 'Changes here apply to this project only and are saved with it.'
              : 'From your author profile in Settings: changes here apply to every project and stay on this computer.'}
          </p>
          {contactField('address', { multiline: true, autoComplete: 'street-address' })}
          <div className="grid gap-3 sm:grid-cols-2">
            {contactField('phone', { type: 'tel', autoComplete: 'tel' })}
            {contactField('email', { type: 'email', autoComplete: 'email' })}
          </div>
          {contactField('agent', { multiline: true })}
          <CheckField meta={C.showAgent} checked={settings.titlePage.showAgent} onChange={(showAgent) => updateManuscriptSettings({ titlePage: { ...settings.titlePage, showAgent } })} />
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-2">
          <div data-field="genre">
            <SelectField meta={C.genre} value={settings.checks.genre} options={[...GENRE_OPTIONS]} onChange={(genre) => updateManuscriptSettings({ checks: { ...settings.checks, genre } })} />
          </div>
          <div className="flex items-end">
            <CheckField meta={C.debut} checked={settings.checks.debut} onChange={(debut) => updateManuscriptSettings({ checks: { ...settings.checks, debut } })} />
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField
            meta={C.rounding}
            value={rounding}
            options={ROUNDING_OPTIONS}
            onChange={(v) => updateManuscriptSettings({ wordCountRounding: v as ManuscriptSettings['wordCountRounding'] })}
          />
          <div className="flex flex-col justify-end text-ui-sm" data-testid="wizard-wordcount">
            <span className="font-semibold">{data.wordCountText}</span>
            <span className="text-ui-xs text-text-muted">
              {data.wordCount.toLocaleString('en-US')} words counted (text and footnotes, tracked changes accepted).
            </span>
          </div>
        </div>
      </div>
      <div className="flex justify-center lg:block">
        <TitlePagePreview settings={settings} data={data} />
      </div>
    </div>
  )
}

// ---- 2. Formatting ---------------------------------------------------------------------------------

let fontsCache: Promise<string[]> | null = null
function useInstalledFonts(): string[] | null {
  const [fonts, setFonts] = useState<string[] | null>(null)
  useEffect(() => {
    let live = true
    fontsCache ??= listSystemFonts()
    void fontsCache.then((f) => live && setFonts(f))
    return () => {
      live = false
    }
  }, [])
  return fonts
}

function FormatStep({ settings, data, prepared }: { settings: ManuscriptSettings; data: TitlePageData; prepared: PreparedManuscript | null }) {
  const fonts = useInstalledFonts()
  const family = settings.fontFamily.trim()
  const mono = /courier|mono/i.test(family)
  const installed = fonts === null || fonts.length === 0 || fonts.some((f) => f.toLowerCase() === family.toLowerCase())
  const fontHint = installed
    ? 'The font the Word file names and the PDF is set in.'
    : `${family} is not installed on this computer. The PDF uses ${mono ? 'Liberation Mono' : 'Liberation Serif'}, a free font with the same letter widths, so the pages break the same; the Word file still names ${family}.`
  const radioName = useId()
  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_auto]">
      <div className="flex min-w-0 flex-col gap-4">
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-ui-sm font-medium">Preset</legend>
          {(Object.keys(PRESETS) as PresetId[]).map((id) => {
            const meta = id === 'standard' ? C.presetStandard : C.presetClassic
            return (
              <Tooltip key={id} wrap controlId={meta.id}>
                <PresetRadio meta={meta} name={radioName} checked={settings.preset === id} description={PRESETS[id].description} onSelect={() => setPreset(id)} />
              </Tooltip>
            )
          })}
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField meta={C.paper} value={settings.paper} options={PAPER_OPTIONS} onChange={(paper) => updateManuscriptSettings({ paper: paper as ManuscriptSettings['paper'] })} />
          <DraftField meta={C.font} value={settings.fontFamily} maxLength={80} onCommit={(fontFamily) => updateManuscriptSettings({ fontFamily })} hint={<span data-testid="font-note">{fontHint}</span>} />
          <DraftField
            meta={C.sceneBreak}
            value={settings.sceneBreak}
            maxLength={20}
            onCommit={(sceneBreak) => updateManuscriptSettings({ sceneBreak })}
            hint='Centred between scenes. "#" is the standard; "* * *" is also accepted.'
          />
          <SelectField meta={C.endMarker} value={settings.endMarker} options={END_OPTIONS} onChange={(endMarker) => updateManuscriptSettings({ endMarker: endMarker as ManuscriptSettings['endMarker'] })} />
        </div>
        <HeaderPreview settings={settings} data={data} />
      </div>
      <div className="flex justify-center lg:block">
        <ChapterPagePreview settings={settings} data={data} ir={prepared?.ir ?? null} />
      </div>
    </div>
  )
}

interface PresetRadioProps {
  meta: ExportControlMeta
  name: string
  checked: boolean
  description: string
  onSelect: () => void
  [prop: string]: unknown
}

/** A preset choice: a native radio with its label and description. Props from the Tooltip go on the radio. */
function PresetRadio({ meta, name, checked, description, onSelect, ...rest }: PresetRadioProps) {
  return (
    <label className="flex min-h-control cursor-pointer items-start gap-2 py-1 text-ui-sm">
      <input
        type="radio"
        name={name}
        aria-label={meta.label}
        data-control-id={meta.id}
        data-mnemonic={meta.mnemonic}
        checked={checked}
        onChange={onSelect}
        className={cn('mt-0.5 size-4 shrink-0 accent-accent', focusRing)}
        {...rest}
      />
      <span>
        <span className="font-medium">
          <Mn text={meta.label} k={meta.mnemonic} />
        </span>
        <span className="block text-ui-xs text-text-muted">{description}</span>
      </span>
    </label>
  )
}

// ---- 3. Checks -------------------------------------------------------------------------------------

const SEVERITY_STYLE: Record<CheckSeverity, string> = {
  blocking: 'text-danger',
  warning: 'text-warning',
  info: 'text-text-muted',
  pass: 'text-success',
}

function SeverityIcon({ severity }: { severity: CheckSeverity }) {
  const path =
    severity === 'pass'
      ? 'M4 8.5l2.5 2.5L12 5.5'
      : severity === 'blocking'
        ? 'M5 5l6 6M11 5l-6 6'
        : severity === 'warning'
          ? 'M8 4v5M8 11.5v.5'
          : 'M8 7v5M8 4.5v.5'
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4 shrink-0">
      <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d={path} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

const ACTION_META: Record<Exclude<CheckAction['kind'], 'show-chapter'>, ExportControlMeta> = {
  fix: C.checkFix,
  'review-changes': C.checkReviewChanges,
  'show-comments': C.checkShowComments,
  'open-rewrite': C.checkOpenRewrite,
}

const FIX_LABEL: Record<WizardField, string> = {
  title: 'Add a title',
  legalName: 'Add your legal name',
  penName: 'Add a name',
  address: 'Add an address',
  phone: 'Add a phone number',
  email: 'Add a way to reach you',
  genre: 'Choose a genre',
}

function ActionButton({ action }: { action: CheckAction }) {
  const meta = action.kind === 'show-chapter' ? C.checkShowChapter : ACTION_META[action.kind]
  const label = action.kind === 'fix' ? FIX_LABEL[action.field] : meta.label
  return (
    <Tooltip side="top">
      <Button data-control-id={meta.id} aria-label={action.kind === 'show-chapter' ? `Show me: ${action.label}` : label} onClick={() => runCheckAction(action)}>
        {label}
      </Button>
    </Tooltip>
  )
}

function ChecksStep({ checks, settings, prepared }: { checks: CheckResult[]; settings: ManuscriptSettings; prepared: PreparedManuscript | null }) {
  if (!prepared) return <p className="text-text-muted">Open a manuscript to check it.</p>
  const sorted = sortChecks(checks)
  const blocking = checks.filter((c) => c.severity === 'blocking').length
  const doubleSpaces = countDoubleSpaces(prepared.ir)
  const report = prepared.ir.report
  const blankBreaks = report.manualSceneBreaks.some((m) => m.kind === 'blank')
  return (
    <div className="flex flex-col gap-3">
      <p role="status" className={cn('text-ui-sm', blocking ? 'font-semibold text-danger' : 'text-text-muted')}>
        {blocking
          ? `${blocking} ${blocking === 1 ? 'problem must' : 'problems must'} be fixed before you can export.`
          : 'Nothing stops the export. Warnings and notes are advice; you can export as it is.'}
      </p>
      <ul className="flex flex-col gap-2" aria-label="Checks">
        {sorted.map((c) => (
          <li key={c.id} data-check={c.id} data-severity={c.severity} className="rounded-control border border-border p-3">
            <div className="flex items-start gap-2">
              <span className={cn('mt-0.5', SEVERITY_STYLE[c.severity])}>
                <SeverityIcon severity={c.severity} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="m-0 text-ui-sm">
                  <span className={cn('font-semibold', SEVERITY_STYLE[c.severity])}>{SEVERITY_LABEL[c.severity]}: </span>
                  <span className="font-medium text-text">{c.summary}</span>
                </p>
                <p className="m-0 mt-1 text-ui-xs text-text-muted">{c.explanation}</p>
                {c.id === 'chapters' && c.actions.length ? (
                  <ul className="mt-2 flex flex-col gap-1.5">
                    {c.actions.map((a, i) =>
                      a.kind === 'show-chapter' ? (
                        <li key={i} className="flex flex-wrap items-center gap-2 text-ui-sm">
                          <span className="min-w-0 flex-1">{a.label}</span>
                          <ActionButton action={a} />
                        </li>
                      ) : null,
                    )}
                  </ul>
                ) : c.actions.length ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {c.actions.map((a, i) => (
                      <ActionButton key={i} action={a} />
                    ))}
                  </div>
                ) : null}
                {c.id === 'double-spaces' && (doubleSpaces > 0 || settings.checks.normalizeSpaces) ? (
                  <div className="mt-2">
                    <CheckField meta={C.normalizeSpaces} checked={settings.checks.normalizeSpaces} onChange={(normalizeSpaces) => updateManuscriptSettings({ checks: { ...settings.checks, normalizeSpaces } })} />
                  </div>
                ) : null}
                {c.id === 'scene-breaks' && (blankBreaks || report.blankLineSpacing || settings.checks.blankLineSceneBreaks === 'off') ? (
                  <div className="mt-2">
                    <CheckField
                      meta={C.blankLines}
                      checked={settings.checks.blankLineSceneBreaks === 'auto'}
                      onChange={(on) => updateManuscriptSettings({ checks: { ...settings.checks, blankLineSceneBreaks: on ? 'auto' : 'off' } })}
                    />
                  </div>
                ) : null}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ---- 4. Export -------------------------------------------------------------------------------------

function RunButton({ meta, onClick, variant = 'secondary', label }: { meta: ExportControlMeta; onClick: () => void; variant?: 'primary' | 'secondary'; label?: string }) {
  return (
    <Tooltip side="top">
      <Button variant={variant} data-control-id={meta.id} data-mnemonic={meta.mnemonic} aria-label={label} onClick={onClick}>
        <Mn text={meta.label} k={meta.mnemonic} />
      </Button>
    </Tooltip>
  )
}

function ExportStep({ settings, data, run, blocked }: { settings: ManuscriptSettings; data: TitlePageData; run: RunState; blocked: boolean }) {
  const renderers = useExportRenderers()
  const folder = useLastOutputFolder()
  const mine = run.origin === 'wizard'
  const running = mine && (run.phase === 'choosing' || run.phase === 'rendering' || run.phase === 'saving')
  const chosen = WIZARD_FORMATS.filter((f) => settings.outputs[f])
  return (
    <div className="flex flex-col gap-4">
      <fieldset className="flex flex-col gap-1" disabled={running}>
        <legend className="mb-1 text-ui-sm font-medium">Formats</legend>
        {WIZARD_FORMATS.map((f) => (
          <div key={f} className="flex flex-col">
            <CheckField
              meta={FORMAT_META[f]}
              checked={settings.outputs[f] && !!renderers[f]}
              disabled={!renderers[f] || running}
              onChange={(on) => updateManuscriptSettings({ outputs: { ...settings.outputs, [f]: on } })}
            />
            {!renderers[f] ? <span className="pl-6 text-ui-xs text-text-muted">Not available in this build of Novel.</span> : null}
          </div>
        ))}
      </fieldset>
      <div className="text-ui-sm">
        <p className="m-0 font-medium">File names</p>
        <ul className="m-0 mt-1 list-none p-0 font-mono text-ui-xs" data-testid="export-file-names">
          {chosen.map((f) => (
            <li key={f}>{manuscriptFileName(data, f)}</li>
          ))}
        </ul>
        <p className="m-0 mt-1 text-ui-xs text-text-muted">
          You choose where to save {chosen.length > 1 ? 'each file' : 'the file'} in the Save dialog{folder ? `, which opens in ${folder}` : ''}.
        </p>
      </div>
      {blocked && !running ? (
        <p className="m-0 text-ui-sm font-semibold text-danger">Fix the problems marked Must fix in Checks (step 3) to export.</p>
      ) : null}
      {mine ? <RunPanel run={run} /> : null}
    </div>
  )
}

const PHASE_TEXT: Partial<Record<RunState['phase'], string>> = {
  choosing: 'Choose where to save in the Save dialog…',
  saving: 'Saving…',
}

/** Progress, error, cancel and success of the wizard's export. */
function RunPanel({ run }: { run: RunState }) {
  if (run.phase === 'ready') return null
  if (run.phase === 'choosing' || run.phase === 'rendering' || run.phase === 'saving') {
    const pct = Math.round(run.progress * 100)
    const text = PHASE_TEXT[run.phase] ?? `Making the ${run.format ? FORMAT_NAME[run.format] : 'files'}… ${pct}%`
    return (
      <div className="flex flex-col gap-2" data-testid="export-progress">
        <p role="status" className="m-0 text-ui-sm">
          {text}
        </p>
        {run.phase !== 'choosing' ? (
          <div role="progressbar" aria-label="Export progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="h-2 overflow-hidden rounded-full border border-border-control bg-surface">
            <div className="h-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
          </div>
        ) : null}
        {run.phase === 'rendering' ? (
          <div>
            <RunButton meta={C.cancelRun} onClick={cancelExport} />
          </div>
        ) : null}
      </div>
    )
  }
  if (run.phase === 'cancelled') {
    return (
      <p role="status" className="m-0 text-ui-sm" data-testid="export-cancelled">
        Export cancelled. No file was written.
      </p>
    )
  }
  if (run.phase === 'error' && run.error) {
    return (
      <div role="alert" className="flex flex-col gap-2 rounded-control border border-danger p-3" data-testid="export-error" data-problem={run.error.problem}>
        <p className="m-0 text-ui-sm font-semibold text-danger">The export did not finish.</p>
        <p className="m-0 text-ui-sm">{run.error.message}</p>
        {run.error.diagnostics.length ? (
          <ul className="m-0 pl-5 font-mono text-ui-xs text-text-muted">
            {run.error.diagnostics.slice(0, 3).map((d, i) => (
              <li key={i}>{d.message}</li>
            ))}
          </ul>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <RunButton meta={C.retry} variant="primary" onClick={() => void retryExport()} />
          {run.error.changeLocation ? <RunButton meta={C.chooseLocation} onClick={() => void chooseOtherLocation()} /> : null}
        </div>
      </div>
    )
  }
  if (run.phase === 'done') {
    return (
      <div className="flex flex-col gap-2" data-testid="export-done">
        <p role="status" className="m-0 text-ui-sm font-semibold text-success">
          Exported {run.written.length === 1 ? 'the manuscript' : `${run.written.length} files`}.
        </p>
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {run.written.map((f) => (
            <li key={f.path} className="flex flex-wrap items-center gap-2 text-ui-sm">
              <span className="min-w-0 flex-1 break-all font-mono text-ui-xs" title={f.path}>
                {fileNameOf(f.path)}
              </span>
              <RunButton meta={C.openFile} label={`Open ${fileNameOf(f.path)}`} onClick={() => void openExportedFile(f.path).catch(() => undefined)} />
              <RunButton meta={C.showInFolder} label={`Show ${fileNameOf(f.path)} in folder`} onClick={() => void revealInFolder(f.path).catch(() => undefined)} />
            </li>
          ))}
        </ul>
      </div>
    )
  }
  return null
}
