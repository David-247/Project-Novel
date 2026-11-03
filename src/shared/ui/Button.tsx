import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react'
import { cn, controlBase } from './styles'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'md' | 'lg'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  ref?: Ref<HTMLButtonElement>
}

const variants: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-contrast hover:bg-accent-hover',
  secondary: 'border border-border-control bg-surface-raised text-text hover:bg-surface-hover',
  ghost: 'bg-transparent text-text hover:bg-surface-hover',
  danger: 'bg-danger text-danger-contrast hover:bg-danger-hover',
}

const sizes: Record<ButtonSize, string> = {
  md: 'px-3',
  lg: 'min-h-control-lg px-4 text-ui',
}

/** Text button. Defaults to `type="button"` so it never submits a form by accident. */
export function Button({ variant = 'secondary', size = 'md', className, type = 'button', ...rest }: ButtonProps) {
  return <button type={type} className={cn(controlBase, variants[variant], sizes[size], className)} {...rest} />
}

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> {
  /** Accessible name (required: icon-only controls have no visible text). */
  label: string
  children: ReactNode
  ref?: Ref<HTMLButtonElement>
}

/** Square icon-only button for toolbars; 32x32 minimum. Pass an SVG/icon as children. */
export function IconButton({ label, className, type = 'button', children, ...rest }: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      className={cn(controlBase, 'px-1.5 text-text-muted hover:bg-surface-hover hover:text-text', className)}
      {...rest}
    >
      {children}
    </button>
  )
}

export interface ToggleButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-pressed' | 'onChange'> {
  pressed: boolean
  onPressedChange: (pressed: boolean) => void
  /** Accessible name; required when children is only an icon. */
  label?: string
  ref?: Ref<HTMLButtonElement>
}

/**
 * Two-state toolbar button (bold, italic, ...). Exposes `aria-pressed`; pressed state is shown
 * by fill + accent color + an underline bar, so it does not rely on color alone.
 */
export function ToggleButton({
  pressed,
  onPressedChange,
  label,
  className,
  onClick,
  type = 'button',
  ...rest
}: ToggleButtonProps) {
  return (
    <button
      type={type}
      aria-pressed={pressed}
      aria-label={label}
      data-state={pressed ? 'on' : 'off'}
      onClick={(e) => {
        onClick?.(e)
        if (!e.defaultPrevented) onPressedChange(!pressed)
      }}
      className={cn(
        controlBase,
        'relative px-1.5',
        pressed
          ? 'bg-accent-soft text-accent after:absolute after:inset-x-2 after:bottom-1 after:h-0.5 after:rounded-full after:bg-accent'
          : 'text-text-muted hover:bg-surface-hover hover:text-text',
        className,
      )}
      {...rest}
    />
  )
}
