import { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, Ref } from 'react'
import { Checkbox, cn, detectPlatform, fieldBase, Select, TextInput, Tooltip } from '@/shared/ui'
import type { SelectOption } from '@/shared/ui'
import type { ExportControlMeta } from './controls'

/**
 * Small building blocks of the export wizard: Word-style access keys (Alt+<letter>, the letter
 * underlined), text fields that keep a local draft, and labelled controls wired to their tooltip.
 */

/** `text` with the first occurrence of `key` underlined (the access key), as Word's dialogs show it. */
export function Mn({ text, k }: { text: string; k?: string }) {
  if (!k) return <>{text}</>
  const i = text.toLowerCase().indexOf(k.toLowerCase())
  if (i < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, i)}
      <span className="underline underline-offset-2">{text[i]}</span>
      {text.slice(i + 1)}
    </>
  )
}

/** The key of an Alt+key press ('n', '3'), from the physical key (Option+N types "˜" on macOS). */
function accessKey(e: KeyboardEvent | ReactKeyboardEvent): string | null {
  if (!e.altKey || e.ctrlKey || e.metaKey) return null
  const code = e.code
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase()
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  return null
}

const NOT_TEXT = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image', 'hidden'])

/** A control where a key types text (Option+letter types a character there on macOS). */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.tagName === 'TEXTAREA' || target.isContentEditable) return true
  return target.tagName === 'INPUT' && !NOT_TEXT.has((target as HTMLInputElement).type)
}

/**
 * Alt+<key> inside `root`: the first visible, enabled element marked `data-mnemonic="<key>"` is
 * focused; a button, checkbox or radio is also pressed (Word: an access key on a button runs it).
 * Returns true when it handled the key.
 *
 * On macOS, Option+<key> in a text field types a character (ø, ß, the ñ dead key), so it is left to
 * the field there: Word for Mac has no access keys, and a press meant as a letter must never run a
 * control. From any other control (a list, a checkbox, a button) the access keys work on macOS too.
 */
export function handleAccessKey(e: ReactKeyboardEvent, root: HTMLElement | null): boolean {
  const key = accessKey(e)
  if (!key || !root) return false
  if (detectPlatform() === 'mac' && isTextEntry(e.target)) return false
  const candidates = Array.from(root.querySelectorAll<HTMLElement>(`[data-mnemonic="${key}"]`))
  const visible = (c: HTMLElement) => (typeof c.checkVisibility === 'function' ? c.checkVisibility() : !c.closest('[hidden]'))
  const el = candidates.find((c) => !(c as HTMLButtonElement).disabled && c.getAttribute('aria-disabled') !== 'true' && visible(c))
  if (!el) return false
  e.preventDefault()
  e.stopPropagation()
  el.focus()
  const type = (el as HTMLInputElement).type
  if (el.tagName === 'BUTTON' || (el.tagName === 'INPUT' && (type === 'checkbox' || type === 'radio'))) el.click()
  return true
}

export interface DraftOptions {
  /** The stored value. */
  value: string
  /** Store a value. Called on each change that is not blank (when `allowBlank` is false) and on blur. */
  onCommit: (value: string) => void
  /**
   * A blank value can be stored (contact fields). Without it (font, scene-break marker), a cleared
   * field keeps its draft while focused (no snap back to the default as the user types) and shows the
   * stored value again on blur.
   */
  allowBlank?: boolean
}

/**
 * Local draft state for a text field bound to a stored setting: what is typed stays exactly as typed
 * (the store may fall back to a default for a blank value, or trim), and the field follows the store
 * again when it is not focused.
 */
export function useDraft({ value, onCommit, allowBlank = false }: DraftOptions) {
  const [draft, setDraft] = useState(value)
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setDraft(value)
  }, [value])
  return {
    value: draft,
    onChange: (e: { target: { value: string } }) => {
      const next = e.target.value
      setDraft(next)
      if (allowBlank || next.trim() !== '') onCommit(next)
    },
    onFocus: () => {
      focused.current = true
    },
    onBlur: () => {
      focused.current = false
      if (allowBlank || draft.trim() !== '') {
        if (draft !== value) onCommit(draft)
      } else {
        setDraft(value)
      }
    },
  }
}

interface FieldShellProps {
  meta: ExportControlMeta
  htmlFor: string
  hint?: ReactNode
  hintId?: string
  children: ReactNode
  className?: string
}

/** A label above its control, with an optional hint line below. */
export function FieldShell({ meta, htmlFor, hint, hintId, children, className }: FieldShellProps) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)}>
      <label htmlFor={htmlFor} className="text-ui-sm font-medium text-text">
        <Mn text={meta.label} k={meta.mnemonic} />
      </label>
      {children}
      {hint ? (
        <p id={hintId} className="text-ui-xs text-text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  )
}

export interface DraftFieldProps extends DraftOptions {
  meta: ExportControlMeta
  multiline?: boolean
  hint?: ReactNode
  placeholder?: string
  maxLength?: number
  type?: string
  autoComplete?: string
  invalid?: boolean
  className?: string
  inputRef?: Ref<HTMLInputElement & HTMLTextAreaElement>
}

/** A labelled text field (or textarea) with a local draft, its tooltip and its access key. */
export function DraftField({ meta, multiline, hint, placeholder, maxLength, type, autoComplete, invalid, className, inputRef, ...draftOptions }: DraftFieldProps) {
  const id = useId()
  const hintId = `${id}-hint`
  const draft = useDraft(draftOptions)
  const common = {
    id,
    'data-control-id': meta.id,
    'data-mnemonic': meta.mnemonic,
    placeholder,
    maxLength,
    autoComplete,
    'aria-invalid': invalid || undefined,
    'aria-describedby': hint ? hintId : undefined,
    ...draft,
  }
  return (
    <FieldShell meta={meta} htmlFor={id} hint={hint} hintId={hintId} className={className}>
      <Tooltip>
        {multiline ? (
          <textarea {...common} ref={inputRef} rows={3} className={cn(fieldBase, 'w-full min-w-0 resize-y py-1.5 leading-snug')} />
        ) : (
          <TextInput {...common} ref={inputRef} type={type} />
        )}
      </Tooltip>
    </FieldShell>
  )
}

export interface SelectFieldProps {
  meta: ExportControlMeta
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  hint?: ReactNode
  className?: string
  selectRef?: Ref<HTMLSelectElement>
}

export function SelectField({ meta, value, options, onChange, hint, className, selectRef }: SelectFieldProps) {
  const id = useId()
  const hintId = `${id}-hint`
  return (
    <FieldShell meta={meta} htmlFor={id} hint={hint} hintId={hintId} className={className}>
      <Tooltip>
        <Select
          id={id}
          ref={selectRef}
          data-control-id={meta.id}
          data-mnemonic={meta.mnemonic}
          aria-describedby={hint ? hintId : undefined}
          value={value}
          options={options}
          onChange={(e) => onChange(e.target.value)}
          wrapperClassName="w-full"
        />
      </Tooltip>
    </FieldShell>
  )
}

export interface CheckFieldProps {
  meta: ExportControlMeta
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  label?: string
  className?: string
}

/**
 * A labelled checkbox with its tooltip and access key. Disabled is `aria-disabled` (still focusable, so
 * a keyboard user reaches its tooltip and learns why), and a click or Space then changes nothing.
 */
export function CheckField({ meta, checked, onChange, disabled, label, className }: CheckFieldProps) {
  return (
    <Tooltip wrap>
      <Checkbox
        label={<Mn text={label ?? meta.label} k={meta.mnemonic} />}
        aria-label={label ?? meta.label}
        data-control-id={meta.id}
        data-mnemonic={meta.mnemonic}
        checked={checked}
        aria-disabled={disabled || undefined}
        onCheckedChange={(on) => {
          if (!disabled) onChange(on)
        }}
        className={cn(disabled && 'cursor-not-allowed opacity-50', className)}
      />
    </Tooltip>
  )
}
