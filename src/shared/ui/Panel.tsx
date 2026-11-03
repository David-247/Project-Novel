import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from './styles'

export type StatusTone = 'muted' | 'default' | 'success' | 'warning' | 'danger'

export interface PanelProps extends HTMLAttributes<HTMLElement> {
  /** Accessible name; renders as a labelled region. */
  label?: string
}

/** Raised container for docked tools such as the find panel. */
export function Panel({ label, className, ...rest }: PanelProps) {
  return (
    <section
      aria-label={label}
      className={cn(
        'rounded-panel border border-border bg-surface-raised p-3 text-text shadow-raised',
        className,
      )}
      {...rest}
    />
  )
}

export interface StatusTextProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: StatusTone
  /** Announce changes to assistive tech (e.g. "Saved", match counts). */
  live?: boolean
  children: ReactNode
}

const tones: Record<StatusTone, string> = {
  muted: 'text-text-muted',
  default: 'text-text',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
}

/** Short status-bar text (word count, save state). Tabular numbers keep counts from jittering. */
export function StatusText({ tone = 'muted', live = false, className, ...rest }: StatusTextProps) {
  return (
    <span
      aria-live={live ? 'polite' : undefined}
      className={cn('whitespace-nowrap text-ui-xs tabular-nums', tones[tone], className)}
      {...rest}
    />
  )
}
