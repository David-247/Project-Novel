import * as RadixDialog from '@radix-ui/react-dialog'
import type { ReactNode } from 'react'
import { IconButton } from './Button'
import { cn } from './styles'
import { Tooltip } from './Tooltip'

export interface DialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  /** Optional one-line explanation under the title (also the accessible description). */
  description?: string
  children?: ReactNode
  /** Action row, right-aligned. Put the primary action last. */
  footer?: ReactNode
  /** Accessible name for the close (X) button. */
  closeLabel?: string
  /** `data-control-id` of the close (X) button, the key of its tooltip copy. Default "dialog.close". */
  closeControlId?: string
  className?: string
}

/**
 * Modal dialog over Radix Dialog: focus trap, Escape to close, focus return, scroll lock.
 * Width adapts to the window (max 28rem, never wider than viewport minus gutters).
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  closeLabel = 'Close',
  closeControlId = 'dialog.close',
  className,
}: DialogProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-scrim motion-safe:animate-[nv-fade_120ms_ease-out]" />
        <RadixDialog.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-md',
            '-translate-x-1/2 -translate-y-1/2 flex-col rounded-panel border border-border bg-surface-raised text-text shadow-raised',
            'outline-none motion-safe:animate-[nv-rise_140ms_ease-out]',
            className,
          )}
          // Without a description, tell Radix there is intentionally none (avoids its a11y warning).
          {...(description ? {} : { 'aria-describedby': undefined })}
        >
          <div className="flex items-start gap-3 px-5 pb-2 pt-4">
            <div className="min-w-0 flex-1">
              <RadixDialog.Title className="text-ui-lg font-semibold">{title}</RadixDialog.Title>
              {description ? (
                <RadixDialog.Description className="mt-1 text-ui text-text-muted">
                  {description}
                </RadixDialog.Description>
              ) : null}
            </div>
            <RadixDialog.Close asChild>
              <Tooltip>
                <IconButton label={closeLabel} data-control-id={closeControlId} className="-mr-2 -mt-1">
                  <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4">
                    <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                </IconButton>
              </Tooltip>
            </RadixDialog.Close>
          </div>
          {children ? <div className="min-h-0 overflow-auto px-5 py-2 text-ui">{children}</div> : null}
          {footer ? (
            <div className="flex flex-wrap justify-end gap-2 px-5 pb-4 pt-3">{footer}</div>
          ) : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}

/** Wrap a footer button so clicking it closes the dialog. */
export const DialogClose = RadixDialog.Close
