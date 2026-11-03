import { useMemo } from 'react'
import { builtInRegistryVersion, resolveStyleSheet, type ResolvedStyles, type StyleSheetJSON } from '@/shared/book'
import { useStore } from '@/shared/store'

let memo: { stored: StyleSheetJSON; version: number; resolved: ResolvedStyles } | null = null

/** Resolved styles for a stored sheet, memoized on the sheet object and the built-in registry. */
export function resolveStyles(stored: StyleSheetJSON): ResolvedStyles {
  const version = builtInRegistryVersion()
  if (memo && memo.stored === stored && memo.version === version) return memo.resolved
  const resolved = resolveStyleSheet(stored)
  memo = { stored, version, resolved }
  return resolved
}

/** Resolved styles of the current book (O(1) when unchanged). */
export function getResolvedStyles(): ResolvedStyles {
  return resolveStyles(useStore.getState().book.styles)
}

/** Resolved styles of the current book; re-renders when book.styles changes. */
export function useResolvedStyles(): ResolvedStyles {
  const stored = useStore((s) => s.book.styles)
  return useMemo(() => resolveStyles(stored), [stored])
}
