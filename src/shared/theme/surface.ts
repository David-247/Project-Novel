import { useLayoutEffect } from 'react'
import type { PaperSurface } from '@/shared/book'
import { useStore } from '@/shared/store'
import type { ColorScheme } from '@/shared/store'

/** A concrete paper: what `PaperSurface` resolves to once 'auto' has followed the OS. */
export type ResolvedSurface = Exclude<PaperSurface, 'auto'>

/** 'auto' is white paper in light mode and dark paper in dark mode; the others never change. */
export function resolveSurface(surface: PaperSurface, scheme: ColorScheme): ResolvedSurface {
  if (surface !== 'auto') return surface
  return scheme === 'dark' ? 'dark' : 'white'
}

/** Writes the resolved surface onto <html> so every `--page-*` token in surfaces.css switches at once. */
export function applySurfaceAttribute(surface: ResolvedSurface, root: HTMLElement = document.documentElement): void {
  root.dataset.surface = surface
}

/**
 * Keeps `<html data-surface>` in step with `book.surface` and `app.colorScheme` (which
 * useThemeFollow feeds from the OS), so 'auto' switches live with the OS. Call once at the
 * composition root. Applied before paint; colours only, so nothing reflows.
 */
export function useSurfaceFollow(): void {
  const surface = useStore((s) => s.book.surface)
  const scheme = useStore((s) => s.app.colorScheme)
  useLayoutEffect(() => {
    applySurfaceAttribute(resolveSurface(surface, scheme))
  }, [surface, scheme])
}

/** Picker entries. Labels double as accessible names and tooltip titles (the registry derives from here). */
export const SURFACE_CONTROLS = {
  group: { id: 'book.surface', label: 'Paper' },
  auto: { id: 'book.surface.auto', label: 'Auto', value: 'auto' },
  book: { id: 'book.surface.book', label: 'Book', value: 'book' },
  white: { id: 'book.surface.white', label: 'White', value: 'white' },
  dark: { id: 'book.surface.dark', label: 'Dark', value: 'dark' },
} as const

/** Picker options in display order. */
export const SURFACE_OPTIONS = [
  SURFACE_CONTROLS.auto,
  SURFACE_CONTROLS.book,
  SURFACE_CONTROLS.white,
  SURFACE_CONTROLS.dark,
] as const
