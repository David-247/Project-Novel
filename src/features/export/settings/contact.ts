import { useMemo } from 'react'
import { getAuthorProfile, useAuthorProfile } from '@/features/settings'
import { resolveContact } from './text'
import { getContactOverride, useContactOverride } from './store'
import type { ContactDetails } from './types'

/** The contact block for the open project: the app author profile with the project's override on top. */
export function getResolvedContact(): ContactDetails {
  return resolveContact(getAuthorProfile(), getContactOverride())
}

/** Reactive `getResolvedContact()`. */
export function useResolvedContact(): ContactDetails {
  const profile = useAuthorProfile()
  const override = useContactOverride()
  return useMemo(() => resolveContact(profile, override), [profile, override])
}
