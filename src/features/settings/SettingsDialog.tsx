import { useId, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { PAPER_SURFACES, MAX_AUTHOR_NAME, useStore } from '@/shared/store'
import type { PreferenceValues } from '@/shared/store'
import { TRIM_SIZES } from '@/shared/book'
import { Button, Dialog, Select, TextInput, Tooltip } from '@/shared/ui'
import type { SelectOption } from '@/shared/ui'
import { answerAuthorPrompt } from './author'
import { SETTINGS_CONTROLS as C } from './controls'
import type { SettingsControlKey } from './controls'
import { closeSettings, useDialogState } from './dialog-state'
import { flushPreferences } from './persistence'

const NAVIGATION_OPTIONS: SelectOption[] = [
  { value: 'book', label: 'Turn pages like a book' },
  { value: 'scroll', label: 'Scroll through the pages' },
]
const MOTION_OPTIONS: SelectOption[] = [
  { value: 'system', label: 'Follow my computer' },
  { value: 'on', label: 'Reduce motion' },
  { value: 'off', label: 'Allow motion' },
]
const PAPER_LABELS: Record<(typeof PAPER_SURFACES)[number], string> = {
  auto: 'Auto (follows light / dark)',
  book: 'Book (cream)',
  white: 'White',
  dark: 'Dark',
}
const PAPER_OPTIONS: SelectOption[] = PAPER_SURFACES.map((value) => ({ value, label: PAPER_LABELS[value] }))
const TRIM_OPTIONS: SelectOption[] = TRIM_SIZES.map((t) => ({ value: t.id, label: `${t.label} (${t.dimensions})` }))

/** A colour shown when none is chosen yet (the picker needs a value to open on). */
const PICKER_FALLBACK = '#2f6fed'

/** Open the OS colour picker of a (visually hidden) colour input. */
function openColorPicker(input: HTMLInputElement | null) {
  if (!input) return
  try {
    if (typeof input.showPicker === 'function') return input.showPicker()
  } catch {
    // showPicker refuses in some states (e.g. no user activation); a click opens it there.
  }
  input.click()
}

/** Hosts the Settings dialog and the one-time author question (both portal). Render once in the app. */
export function SettingsDialog() {
  const { settingsOpen, promptOpen } = useDialogState()
  return (
    <>
      <Dialog
        open={settingsOpen}
        onOpenChange={(o) => {
          if (!o) {
            closeSettings()
            void flushPreferences()
          }
        }}
        title="Settings"
        description="Changes apply as you make them and are kept for every project on this computer."
        className="sm:max-w-xl"
        footer={
          <>
            <Tooltip>
              <Button
                data-control-id={C.reset.id}
                onClick={() => useStore.getState().preferencesActions.reset()}
              >
                {C.reset.label}
              </Button>
            </Tooltip>
            <Tooltip>
              <Button
                variant="primary"
                data-control-id={C.done.id}
                onClick={() => {
                  closeSettings()
                  void flushPreferences()
                }}
              >
                {C.done.label}
              </Button>
            </Tooltip>
          </>
        }
      >
        {settingsOpen ? <SettingsForm /> : null}
      </Dialog>
      <AuthorPrompt open={promptOpen} />
    </>
  )
}

function SettingsForm() {
  const prefs = useStore((s) => s.preferences)
  const set = useStore((s) => s.preferencesActions.set)
  const formId = useId()
  const colorInput = useRef<HTMLInputElement>(null)

  const section = (key: string, title: string, children: ReactNode) => (
    <section aria-labelledby={`${formId}-${key}`} className="flex flex-col gap-3 border-t border-border py-3 first:border-t-0 first:pt-0">
      <h3 id={`${formId}-${key}`} className="m-0 text-ui font-semibold">
        {title}
      </h3>
      {children}
    </section>
  )

  const field = (
    key: SettingsControlKey,
    control: (p: { id: string; 'data-control-id': string; 'aria-describedby': string }) => ReactElement,
    hint: string,
  ) => {
    const id = `${formId}-${key}`
    return (
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={id} className="text-ui-xs font-medium text-text-muted">
          {C[key].label}
        </label>
        <Tooltip>{control({ id, 'data-control-id': C[key].id, 'aria-describedby': `${id}-hint` })}</Tooltip>
        <p id={`${id}-hint`} className="m-0 text-ui-xs text-text-muted">
          {hint}
        </p>
      </div>
    )
  }

  const select = <K extends keyof PreferenceValues>(key: K, options: SelectOption[]) => (p: object) => (
    <Select {...p} value={String(prefs[key])} options={options} onChange={(e) => set(key, e.target.value as PreferenceValues[K])} />
  )

  return (
    <div className="flex flex-col">
      {section(
        'general',
        'General',
        <>
          {field(
            'authorName',
            (p) => (
              <TextInput
                {...p}
                value={prefs.authorName}
                maxLength={MAX_AUTHOR_NAME}
                autoComplete="name"
                onChange={(e) => set('authorName', e.target.value)}
              />
            ),
            'Shown on your tracked changes and comments. Starts as the name of your computer account.',
          )}
          <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor={`${formId}-authorColor`} className="text-ui-xs font-medium text-text-muted">
              {C.authorColor.label}
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <Tooltip>
                <Button
                  id={`${formId}-authorColor`}
                  data-control-id={C.authorColor.id}
                  // The current value is read with the name ("#aa3366" or "Chosen for you"), then the hint.
                  aria-describedby={`${formId}-authorColor-value ${formId}-authorColor-hint`}
                  aria-haspopup="dialog"
                  className="w-14 p-1"
                  onClick={() => openColorPicker(colorInput.current)}
                >
                  <span
                    aria-hidden="true"
                    className="block h-5 w-full rounded-sm border border-border-control"
                    style={{ backgroundColor: prefs.authorColor ?? PICKER_FALLBACK }}
                  />
                </Button>
              </Tooltip>
              {/*
                The OS colour picker. Not a tab stop itself: WebKit on macOS never moves keyboard focus to
                an <input type="color"> (not even with Option+Tab), so the button above opens it.
              */}
              <input
                ref={colorInput}
                type="color"
                tabIndex={-1}
                aria-hidden="true"
                data-tooltip-proxy=""
                data-testid="settings-author-color-picker"
                className="sr-only"
                value={prefs.authorColor ?? PICKER_FALLBACK}
                onChange={(e) => set('authorColor', e.target.value.toLowerCase())}
              />
              <Tooltip>
                <Button
                  data-control-id={C.authorColorAuto.id}
                  disabled={prefs.authorColor === null}
                  onClick={() => set('authorColor', null)}
                >
                  {C.authorColorAuto.label}
                </Button>
              </Tooltip>
              <span id={`${formId}-authorColor-value`} className="text-ui-xs text-text-muted">
                {prefs.authorColor ?? 'Chosen for you'}
              </span>
            </div>
            <p id={`${formId}-authorColor-hint`} className="m-0 text-ui-xs text-text-muted">
              Colours your changes and comments. Automatic picks one for you.
            </p>
          </div>
        </>,
      )}
      {section(
        'writing',
        'Writing view',
        <>
          {field(
            'pageNavigation',
            select('pageNavigation', NAVIGATION_OPTIONS),
            'Applies to page navigation in the writing view: turn pages like a book, or scroll.',
          )}
          {field('reduceMotion', select('reduceMotion', MOTION_OPTIONS), 'Animations such as page turns and dialogs.')}
        </>,
      )}
      {section(
        'new',
        'New projects',
        <>
          {field('defaultPaper', select('defaultPaper', PAPER_OPTIONS), 'The paper a new project starts with. Existing projects keep theirs.')}
          {field('defaultTrimSize', select('defaultTrimSize', TRIM_OPTIONS), 'The page size a new project starts with. Existing projects keep theirs.')}
        </>,
      )}
    </div>
  )
}

/** The one-time "who is writing?" question, asked when a tracked change or comment needs a name. */
function AuthorPrompt({ open }: { open: boolean }) {
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && answerAuthorPrompt(null)}
      title="Who is writing?"
      description="Your name goes on the changes and comments you make, so you can tell them from anyone else's. You can change it later in Settings."
    >
      {open ? <AuthorPromptForm /> : null}
    </Dialog>
  )
}

function AuthorPromptForm() {
  const [name, setName] = useState('')
  const id = useId()
  const valid = name.trim() !== ''
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (valid) answerAuthorPrompt(name)
      }}
    >
      <div className="flex flex-col gap-1">
        <label htmlFor={id} className="text-ui-xs font-medium text-text-muted">
          {C.promptName.label}
        </label>
        <Tooltip>
          <TextInput
            id={id}
            data-control-id={C.promptName.id}
            value={name}
            maxLength={MAX_AUTHOR_NAME}
            autoComplete="name"
            autoFocus
            onChange={(e) => setName(e.target.value)}
          />
        </Tooltip>
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Tooltip>
          <Button data-control-id={C.promptSkip.id} onClick={() => answerAuthorPrompt(null)}>
            {C.promptSkip.label}
          </Button>
        </Tooltip>
        <Tooltip>
          <Button type="submit" variant="primary" data-control-id={C.promptSave.id} disabled={!valid}>
            {C.promptSave.label}
          </Button>
        </Tooltip>
      </div>
    </form>
  )
}
