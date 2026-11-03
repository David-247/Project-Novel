// Intentional violation: relative deep import into another slice.
import { secret } from '../storage/internal'

export const y = secret
