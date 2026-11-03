import type { HTMLAttributes } from 'react'
import { cn } from './styles'

export interface ToolbarGroupProps extends HTMLAttributes<HTMLDivElement> {
  /** Accessible name for the group, e.g. "Text formatting". */
  label: string
}

/** A labelled cluster of related toolbar controls. Wraps rather than overflowing on narrow windows. */
export function ToolbarGroup({ label, className, ...rest }: ToolbarGroupProps) {
  return <div role="group" aria-label={label} className={cn('flex flex-wrap items-center gap-0.5', className)} {...rest} />
}

/** Thin vertical divider between toolbar groups (decorative to sighted users, announced as a separator). */
export function ToolbarSeparator({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      className={cn('mx-1.5 h-5 w-px shrink-0 bg-border', className)}
      {...rest}
    />
  )
}
