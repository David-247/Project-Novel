import type { IconButtonProps } from '@/shared/ui'
import { IconButton, Tooltip } from '@/shared/ui'
import { HEADER_FOOTER_CONTROLS } from './controls'
import { openHeaderFooterDialog, useOpenDialog } from './dialog-state'

export type HeaderFooterButtonProps = Partial<Omit<IconButtonProps, 'label' | 'children'>>

/** A page with a running head, a line of text and a page number. */
function HeaderFooterIcon() {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="1.75" width="10" height="12.5" rx="1" />
      <path d="M5.5 4.5h5M5.5 8h5" />
      <path d="M7 11.75h2" />
    </svg>
  )
}

/**
 * Toolbar button (`book.headerFooter`) that opens the "Headers & page numbers" dialog: the keyboard
 * and touch route to what a double-click on a page's header or footer also opens. Extra props and
 * `ref` are forwarded, so it can be wrapped in the editor's `ToolbarItem`.
 */
export function HeaderFooterButton({ onClick, ...rest }: HeaderFooterButtonProps) {
  const open = useOpenDialog() !== null
  return (
    <Tooltip {...rest}>
      <IconButton
        label={HEADER_FOOTER_CONTROLS.open.label}
        data-control-id={HEADER_FOOTER_CONTROLS.open.id}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(e) => {
          onClick?.(e)
          if (!e.defaultPrevented) openHeaderFooterDialog('settings')
        }}
      >
        <HeaderFooterIcon />
      </IconButton>
    </Tooltip>
  )
}
