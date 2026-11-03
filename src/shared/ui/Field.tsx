import { useId } from 'react'
import type { InputHTMLAttributes, ReactNode, Ref, SelectHTMLAttributes } from 'react'
import { cn, fieldBase, focusRing } from './styles'

export interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  ref?: Ref<HTMLInputElement>
}

/** Single-line text field. Give it a visible <label> or `aria-label`. */
export function TextInput({ className, type = 'text', ...rest }: TextInputProps) {
  return <input type={type} className={cn(fieldBase, 'w-full min-w-0', className)} {...rest} />
}

export interface SelectOption {
  value: string
  label: string
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children'> {
  options: SelectOption[]
  /** Classes for the positioning wrapper <span> (layout: width, margins, flex). `className` goes on the <select>. */
  wrapperClassName?: string
  ref?: Ref<HTMLSelectElement>
}

/**
 * Native <select> (keyboard, touch and screen-reader behaviour for free) styled to the tokens.
 * The chevron is an inline SVG in currentColor, so it follows the theme.
 */
export function Select({ options, className, wrapperClassName, ...rest }: SelectProps) {
  return (
    <span className={cn('relative inline-flex', wrapperClassName)}>
      <select className={cn(fieldBase, 'w-full appearance-none pr-8', className)} {...rest}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        className="pointer-events-none absolute right-2 top-1/2 size-4 -translate-y-1/2 text-text-muted"
      >
        <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  )
}

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange'> {
  label: ReactNode
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  ref?: Ref<HTMLInputElement>
}

/** Native checkbox with a 32px-tall clickable label row. */
export function Checkbox({ label, checked, onCheckedChange, className, id, ...rest }: CheckboxProps) {
  const autoId = useId()
  const inputId = id ?? autoId
  return (
    <label
      htmlFor={inputId}
      className={cn('inline-flex min-h-control cursor-pointer items-center gap-2 text-ui-sm text-text', className)}
    >
      <input
        id={inputId}
        type="checkbox"
        checked={checked}
        onChange={(e) => onCheckedChange(e.target.checked)}
        className={cn(
          'size-4 shrink-0 cursor-pointer rounded-[3px] border border-border-control accent-accent',
          focusRing,
        )}
        {...rest}
      />
      <span>{label}</span>
    </label>
  )
}
