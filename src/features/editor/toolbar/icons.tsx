import type { ReactNode } from 'react'

/** 16px stroke icons drawn in currentColor so they follow the theme. Decorative (aria-hidden). */
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 16 16"
      className="size-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  )
}

export const BoldIcon = () => (
  <Icon>
    <path d="M4.5 2.5h4.25a2.75 2.75 0 0 1 0 5.5H4.5zM4.5 8h5a2.75 2.75 0 0 1 0 5.5h-5z" strokeWidth="2" />
  </Icon>
)
export const ItalicIcon = () => (
  <Icon>
    <path d="M7 2.5h5M4 13.5h5M10 2.5 6.5 13.5" />
  </Icon>
)
export const UnderlineIcon = () => (
  <Icon>
    <path d="M4.5 2.5v4.5a3.5 3.5 0 0 0 7 0V2.5M3 14h10" />
  </Icon>
)
export const BulletListIcon = () => (
  <Icon>
    <path d="M6.5 4h7M6.5 8h7M6.5 12h7" />
    <circle cx="3" cy="4" r="0.9" fill="currentColor" stroke="none" />
    <circle cx="3" cy="8" r="0.9" fill="currentColor" stroke="none" />
    <circle cx="3" cy="12" r="0.9" fill="currentColor" stroke="none" />
  </Icon>
)
export const OrderedListIcon = () => (
  <Icon>
    <path d="M6.5 4h7M6.5 8h7M6.5 12h7" />
    <path d="M2 3l1-.5V5.5M2 9a1 1 0 0 1 1.8.6L2 11.5h2" strokeWidth="1" />
  </Icon>
)
export const AlignLeftIcon = () => (
  <Icon>
    <path d="M2 3h12M2 6.5h8M2 10h12M2 13.5h8" />
  </Icon>
)
export const AlignCenterIcon = () => (
  <Icon>
    <path d="M2 3h12M4 6.5h8M2 10h12M4 13.5h8" />
  </Icon>
)
export const AlignRightIcon = () => (
  <Icon>
    <path d="M2 3h12M6 6.5h8M2 10h12M6 13.5h8" />
  </Icon>
)
export const AlignJustifyIcon = () => (
  <Icon>
    <path d="M2 3h12M2 6.5h12M2 10h12M2 13.5h12" />
  </Icon>
)
export const IndentIncreaseIcon = () => (
  <Icon>
    <path d="M7 3h7M7 6.5h7M7 10h7M2 13.5h12M2 5.25l2.5 2.5L2 10.25" />
  </Icon>
)
export const IndentDecreaseIcon = () => (
  <Icon>
    <path d="M7 3h7M7 6.5h7M7 10h7M2 13.5h12M4.5 5.25 2 7.75l2.5 2.5" />
  </Icon>
)
