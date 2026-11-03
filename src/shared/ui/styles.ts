/** Joins class names, skipping falsy values. */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

/** Visible keyboard focus for every interactive primitive (3:1 against all planes, tested). */
export const focusRing =
  'outline-hidden focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-focus-ring'

/** Shared base for button-like controls: 32px minimum target, no hover-only affordances. */
export const controlBase = cn(
  'inline-flex min-h-control min-w-control shrink-0 select-none items-center justify-center gap-1.5',
  'rounded-control text-ui-sm font-medium transition-colors duration-100',
  'disabled:cursor-not-allowed disabled:opacity-50',
  focusRing,
)

/** Shared base for text fields and selects. */
export const fieldBase = cn(
  'min-h-control rounded-control border border-border-control bg-surface-raised px-2.5 text-ui-sm text-text',
  'placeholder:text-text-muted disabled:cursor-not-allowed disabled:opacity-50',
  'aria-invalid:border-danger',
  focusRing,
)
