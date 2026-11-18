// Intentional violation: outline reaching into editor internals (it must use "@/features/editor").
import { getChapters } from '@/features/editor/breaks/chapters'

export const x = getChapters
