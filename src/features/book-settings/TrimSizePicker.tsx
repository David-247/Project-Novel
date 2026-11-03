import * as Menu from '@radix-ui/react-dropdown-menu'
import type { Ref } from 'react'
import {
  marginsEqual,
  resolveTrimSize,
  TRIM_REGIONS,
  trimSizesByRegion,
  type TrimSizeId,
} from '@/shared/book'
import { useStore } from '@/shared/store'
import { Button, cn, focusRing, Tooltip } from '@/shared/ui'

export const TRIM_SIZE_CONTROL_ID = 'book.trimSize'
/** `data-control-id` of one size in the menu. */
export const trimSizeItemControlId = (id: TrimSizeId) => `${TRIM_SIZE_CONTROL_ID}.${id}`

export interface TrimSizePickerProps {
  /** Props from an asChild parent (a toolbar item) land on the trigger button. */
  [prop: string]: unknown
  ref?: Ref<HTMLButtonElement>
}

/**
 * Trim size picker (toolbar `book.trimSize`): a Radix dropdown menu of the catalog sizes grouped
 * US / UK/EU, each shown as a label and its dimensions. Choosing one dispatches
 * `bookActions.setTrimSize`; if the margins were still the previous size's defaults they follow the
 * new size's defaults, so a customised margin is never overwritten.
 * Keyboard: Enter/Space/ArrowDown opens, arrows move, Enter selects, Escape closes (focus returns to
 * the trigger). Items are 40px tall for touch.
 */
export function TrimSizePicker({ ref, ...forwarded }: TrimSizePickerProps) {
  const trimSize = useStore((s) => s.book.trimSize)
  const current = resolveTrimSize(trimSize)

  const choose = (id: TrimSizeId) => {
    const { book, bookActions } = useStore.getState()
    if (id === book.trimSize) return
    const previous = resolveTrimSize(book.trimSize)
    const next = resolveTrimSize(id)
    if (marginsEqual(book.margins, previous.margins) && !marginsEqual(book.margins, next.margins)) {
      bookActions.setMargins({ ...next.margins })
    }
    bookActions.setTrimSize(id)
  }

  return (
    <Menu.Root modal={false}>
      <Tooltip controlId={TRIM_SIZE_CONTROL_ID} {...forwarded} ref={ref as Ref<HTMLElement>}>
        <Menu.Trigger asChild>
          <Button
            variant="ghost"
            data-control-id={TRIM_SIZE_CONTROL_ID}
            aria-label={`Trim size: ${current.label}, ${current.dimensions}`}
            className="gap-2"
          >
            <span>{current.label}</span>
            <span className="text-text-muted">{current.dimensions}</span>
            <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4 text-text-muted">
              <path
                d="M4 6l4 4 4-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </Button>
        </Menu.Trigger>
      </Tooltip>
      <Menu.Portal>
        <Menu.Content
          align="start"
          sideOffset={6}
          collisionPadding={8}
          className="z-40 min-w-64 max-w-[calc(100vw-1rem)] rounded-control border border-border bg-surface-raised p-1 text-text shadow-raised"
        >
          <Menu.RadioGroup value={trimSize} onValueChange={choose}>
            {TRIM_REGIONS.map((region) => (
              <Menu.Group key={region} aria-label={region}>
                <Menu.Label className="px-2.5 pb-0.5 pt-1.5 text-ui-xs font-semibold uppercase tracking-wide text-text-muted">
                  {region}
                </Menu.Label>
                {trimSizesByRegion(region).map((t) => (
                  <Tooltip key={t.id} side="right" controlId={trimSizeItemControlId(t.id)}>
                    <Menu.RadioItem
                      value={t.id}
                      data-control-id={trimSizeItemControlId(t.id)}
                      className={cn(
                        'flex min-h-control-lg cursor-default select-none items-center gap-3 rounded-control py-1.5 pl-7 pr-2.5',
                        'text-ui-sm data-[highlighted]:bg-surface-hover',
                        focusRing,
                      )}
                    >
                      <Menu.ItemIndicator className="absolute left-2 inline-flex items-center">
                        <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4">
                          <path
                            d="M3.5 8.5l3 3 6-7"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.75"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </Menu.ItemIndicator>
                      <span className="flex-1 font-medium">{t.label}</span>
                      <span className="text-text-muted">{t.dimensions}</span>
                    </Menu.RadioItem>
                  </Tooltip>
                ))}
              </Menu.Group>
            ))}
          </Menu.RadioGroup>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  )
}
