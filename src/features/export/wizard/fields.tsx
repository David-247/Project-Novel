import { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, Ref } from 'react'
import { Checkbox, cn, fieldBase, Select, TextInput, Tooltip } from '@/shared/ui'
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

const TAB_STOPS = 'a[href], button, input, select, textarea, [tabindex]'

/** The Tab stops of `root` in DOM order (no positive tabindex is used): enabled, visible, not tabindex -1, one per radio group. */
function tabStops(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(TAB_STOPS)).filter((el) => {
    if ((el as HTMLButtonElement).disabled || el.tabIndex < 0) return false
    if (typeof el.checkVisibility === 'function' ? !el.checkVisibility() : el.closest('[hidden]')) return false
    const input = el as HTMLInputElement
    return !(el.tagName === 'INPUT' && input.type === 'radio' && !input.checked && input.name !== '')
  })
}

/**
 * Option+Tab (Alt+Tab), Safari's and WKWebView's "every control" Tab when "Keyboard navigation" is
 * off: the dialog's focus trap (Radix FocusScope) only loops a plain Tab, so at the last control
 * Option+Tab would stop. Loop it the same way: past the last stop to the first, Shift before the
 * first to the last. Returns true when it moved the focus.
 *
 * Forward, the dialog itself (tabindex -1, before its first stop) takes the focus and the browser's
 * own Option+Tab then moves it on to the first stop, so the move is a keyboard one and shows the focus
 * ring (in macOS WebKit a focus moved by script after a modified key is not :focus-visible); where the
 * browser does not move it on (Chromium), the target is focused right after. Backward, or with a root
 * that cannot take the focus, the target is focused asking for the ring.
 */
export function loopOptionTab(e: KeyboardEvent | ReactKeyboardEvent, root: HTMLElement | null): boolean {
  if (e.key !== 'Tab' || !e.altKey || e.ctrlKey || e.metaKey || !root) return false
  const stops = tabStops(root)
  if (!stops.length) return false
  const at = stops.indexOf(document.activeElement as HTMLElement)
  const target = e.shiftKey ? (at <= 0 ? stops[stops.length - 1] : null) : at === stops.length - 1 || at < 0 ? stops[0] : null
  if (!target) return false
  if (!e.shiftKey && root.hasAttribute('tabindex') && root.tabIndex < 0) {
    root.focus({ preventScroll: true })
    // A browser whose Option+Tab does not move the focus (Chromium) leaves it on the dialog: finish the move.
    setTimeout(() => {
      if (document.activeElement === root) target.focus({ focusVisible: true } as FocusOptions)
    }, 0)
    return true
  }
  e.preventDefault()
  target.focus({ focusVisible: true } as FocusOptions)
  return true
}

/**
 * Alt+<key> inside `root`: the first visible, enabled element marked `data-mnemonic="<key>"` is
 * focused; a button, checkbox or radio is also pressed (Word: an access key on a button runs it).
 * Returns true when it handled the key.
 */
export function handleAccessKey(e: ReactKeyboardEvent, root: HTMLElement | null): boolean {
  const key = accessKey(e)
  if (!key || !root) return false
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

export function CheckField({ meta, checked, onChange, disabled, label, className }: CheckFieldProps) {
  return (
    <Tooltip wrap>
      <Checkbox
        label={<Mn text={label ?? meta.label} k={meta.mnemonic} />}
        aria-label={label ?? meta.label}
        data-control-id={meta.id}
        data-mnemonic={meta.mnemonic}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        className={className}
      />
    </Tooltip>
  )
}
