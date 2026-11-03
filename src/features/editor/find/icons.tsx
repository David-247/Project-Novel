import type { ReactNode } from 'react'

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      className="size-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  )
}

export const UndoIcon = () => (
  <Icon>
    <path d="M7.5 5 4 8.5 7.5 12" />
    <path d="M4 8.5h8a4 4 0 0 1 0 8h-2" />
  </Icon>
)

export const RedoIcon = () => (
  <Icon>
    <path d="M12.5 5 16 8.5 12.5 12" />
    <path d="M16 8.5H8a4 4 0 0 0 0 8h2" />
  </Icon>
)

export const SearchIcon = () => (
  <Icon>
    <circle cx="8.5" cy="8.5" r="5" />
    <path d="m12.5 12.5 4 4" />
  </Icon>
)

export const ChevronUpIcon = () => (
  <Icon>
    <path d="m5.5 12.5 4.5-4.5 4.5 4.5" />
  </Icon>
)

export const ChevronDownIcon = () => (
  <Icon>
    <path d="m5.5 7.5 4.5 4.5 4.5-4.5" />
  </Icon>
)

export const CloseIcon = () => (
  <Icon>
    <path d="m5.5 5.5 9 9M14.5 5.5l-9 9" />
  </Icon>
)
