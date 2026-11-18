// Intentional violation: relative deep import into the settings SLICE (../settings is a sibling slice here).
import { getAuthorProfile } from '../settings/author-profile'

export const x = getAuthorProfile
