import type { ReactNode } from 'react'

function Icon({ children, size = 'size-5' }: { children: ReactNode; size?: string }) {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 20 20" className={size} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  )
}

/** A speech balloon with a plus. */
export const NewCommentIcon = () => (
  <Icon>
    <path d="M4 4.5h12a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H9l-3.5 3v-3H4a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1Z" />
    <path d="M10 6.5v5M7.5 9h5" />
  </Icon>
)

/** A page with a column of balloons beside it. */
export const CommentsPanelIcon = () => (
  <Icon>
    <rect x="2.75" y="3" width="8.5" height="14" rx="1" />
    <path d="M13.5 4.5h4v3h-2.5l-1.5 1.25ZM13.5 11h4v3h-2.5l-1.5 1.25Z" />
  </Icon>
)

export const ChevronUpIcon = () => (
  <Icon>
    <path d="m5.5 12 4.5-4.5 4.5 4.5" />
  </Icon>
)

export const ChevronDownIcon = () => (
  <Icon>
    <path d="m5.5 8 4.5 4.5 4.5-4.5" />
  </Icon>
)

export const CheckIcon = () => (
  <Icon size="size-4">
    <path d="m4.5 10.5 3.5 3.5 7.5-8" />
  </Icon>
)

export const ReopenIcon = () => (
  <Icon size="size-4">
    <path d="M4.5 10a5.5 5.5 0 1 0 1.8-4.1" />
    <path d="M4 3.5v3.25h3.25" />
  </Icon>
)

export const TrashIcon = () => (
  <Icon size="size-4">
    <path d="M4 6h12M8 6V4.5h4V6M6 6l.75 10h6.5L14 6" />
  </Icon>
)

export const PencilIcon = () => (
  <Icon size="size-4">
    <path d="M12.5 4.5 15.5 7.5 7.5 15.5H4.5v-3Z" />
  </Icon>
)

export const CloseIcon = () => (
  <Icon>
    <path d="m5.5 5.5 9 9M14.5 5.5l-9 9" />
  </Icon>
)

export const JumpIcon = () => (
  <Icon size="size-4">
    <path d="M8 5H5v10h10v-3" />
    <path d="M11 4h5v5M16 4l-7 7" />
  </Icon>
)

export const ResolvedIcon = () => (
  <Icon>
    <circle cx="10" cy="10" r="6.5" />
    <path d="m7 10.25 2 2 4-4.25" />
  </Icon>
)
