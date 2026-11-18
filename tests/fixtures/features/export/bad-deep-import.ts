// Intentional violation: export reaching into settings internals (it must use "@/features/settings").
import { getAuthorProfile } from '@/features/settings/author-profile'

export const x = getAuthorProfile
