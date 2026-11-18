import { PROFILE_MAX, useStore } from '@/shared/store'
import type { PreferenceValues } from '@/shared/store'

/**
 * The author profile (Phase 4): the contact block of an exported manuscript's title page, kept in app
 * Settings next to the tracked-changes author (like Word's user information), never in a project
 * folder unless a project overrides a field (export slice).
 */
export interface AuthorProfile {
  legalName: string
  /** The name on the by-line; '' = the legal name. */
  penName: string
  /** Line breaks kept. */
  address: string
  phone: string
  email: string
  /** Line breaks kept. */
  agent: string
}

type P = Pick<PreferenceValues, keyof typeof PROFILE_MAX>

let last: AuthorProfile = { legalName: '', penName: '', address: '', phone: '', email: '', agent: '' }

/** The same object until a field changes, so it is safe in dependency lists and as a store selector result. */
function stable(p: P): AuthorProfile {
  const next: AuthorProfile = {
    legalName: p.profileLegalName.trim(),
    penName: p.profilePenName.trim(),
    address: p.profileAddress.trim(),
    phone: p.profilePhone.trim(),
    email: p.profileEmail.trim(),
    agent: p.profileAgent.trim(),
  }
  if (JSON.stringify(next) !== JSON.stringify(last)) last = next
  return last
}

/** The author profile from app Settings (non-React). */
export function getAuthorProfile(): AuthorProfile {
  return stable(useStore.getState().preferences)
}

/** Reactive `getAuthorProfile()` (a stable reference between changes). */
export function useAuthorProfile(): AuthorProfile {
  // Select the primitives, build the object outside the selector (a new object per call would loop).
  const legal = useStore((s) => s.preferences.profileLegalName)
  const pen = useStore((s) => s.preferences.profilePenName)
  const address = useStore((s) => s.preferences.profileAddress)
  const phone = useStore((s) => s.preferences.profilePhone)
  const email = useStore((s) => s.preferences.profileEmail)
  const agent = useStore((s) => s.preferences.profileAgent)
  return stable({ profileLegalName: legal, profilePenName: pen, profileAddress: address, profilePhone: phone, profileEmail: email, profileAgent: agent })
}
