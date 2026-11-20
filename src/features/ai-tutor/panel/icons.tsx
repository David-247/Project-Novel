import type { ReactNode } from 'react'
import { cn } from '@/shared/ui'

/** The panel's icons: 20-unit strokes in currentColor, like the ribbon's. */
function Icon({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className={cn('size-4 shrink-0', className)} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  )
}

/** The AI sparkle (the ribbon's Tutor button and the panel's title). */
export const SparkleIcon = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <path d="M9 2.5l1.6 4.4L15 8.5l-4.4 1.6L9 14.5l-1.6-4.4L3 8.5l4.4-1.6zM15.2 12.5l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7z" />
  </Icon>
)

export const HistoryIcon = () => (
  <Icon>
    <path d="M3.5 10a6.5 6.5 0 106.5-6.5A6.6 6.6 0 004.6 6.4M3.5 3.5v3h3M10 6.5V10l2.5 1.5" />
  </Icon>
)

export const NewChatIcon = () => (
  <Icon>
    <path d="M16.5 10.5v3a1.5 1.5 0 01-1.5 1.5H9l-4 3v-3H4.5A1.5 1.5 0 013 13.5v-8A1.5 1.5 0 014.5 4H10M15 2.5v5M12.5 5h5" />
  </Icon>
)

export const CloseIcon = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" />
  </Icon>
)

export const PlusIcon = () => (
  <Icon>
    <path d="M10 4v12M4 10h12" />
  </Icon>
)

export const SendIcon = () => (
  <Icon>
    <path d="M10 16V4.5M5 9.5l5-5 5 5" />
  </Icon>
)

export const StopIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 20 20" className="size-4 shrink-0">
    <rect x="5.5" y="5.5" width="9" height="9" rx="1.5" fill="currentColor" />
  </svg>
)

export const ChevronDownIcon = () => (
  <Icon className="size-3.5">
    <path d="M5.5 8l4.5 4.5L14.5 8" />
  </Icon>
)

export const ChevronRightIcon = () => (
  <Icon className="size-3.5">
    <path d="M8 5.5l4.5 4.5L8 14.5" />
  </Icon>
)

export const BackIcon = () => (
  <Icon>
    <path d="M12 4.5L6.5 10l5.5 5.5" />
  </Icon>
)

export const CheckIcon = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <path d="M4 10.5l4 4 8-9" />
  </Icon>
)

export const TrashIcon = () => (
  <Icon>
    <path d="M4 5.5h12M8 5.5V4h4v1.5M5.5 5.5l.8 10.5h7.4l.8-10.5M8.5 8.5v5M11.5 8.5v5" />
  </Icon>
)

export const PageIcon = () => (
  <Icon>
    <path d="M5 2.5h7l3 3v12H5zM12 2.5v3h3M7.5 9h5M7.5 12h5" />
  </Icon>
)

export const ChapterIcon = () => (
  <Icon>
    <path d="M10 5.5C8.5 4 6 3.5 3 3.5v12c3 0 5.5.5 7 2 1.5-1.5 4-2 7-2v-12c-3 0-5.5.5-7 2zM10 5.5v12" />
  </Icon>
)

export const SelectionIcon = () => (
  <Icon>
    <path d="M4 5h12M4 9h12M4 13h7M14 11.5v6M12.5 11.5h3M12.5 17.5h3" />
  </Icon>
)

export const BookIcon = () => (
  <Icon>
    <path d="M4.5 3.5h9a2 2 0 012 2v11h-9a2 2 0 01-2-2zM4.5 14.5a2 2 0 012-2h9M8 7h4" />
  </Icon>
)

export const CompareIcon = () => (
  <Icon>
    <path d="M2.5 4.5h6.5v11H2.5zM11 4.5h6.5v11H11z" />
  </Icon>
)

export const WarningIcon = () => (
  <Icon>
    <path d="M10 3l7.5 13h-15zM10 8v3.5M10 14v.01" />
  </Icon>
)

export const RetryIcon = () => (
  <Icon>
    <path d="M16 10a6 6 0 11-1.8-4.3M16 3.5v3h-3" />
  </Icon>
)

export const LinkIcon = () => (
  <Icon>
    <path d="M8.5 11.5l3-3M7 9l-1.5 1.5a2.5 2.5 0 003.5 3.5L10.5 12.5M13 11l1.5-1.5A2.5 2.5 0 0011 6L9.5 7.5" />
  </Icon>
)
