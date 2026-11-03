import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useStore } from '@/shared/store'
import {
  contrastRatio,
  parseSurfaceTokens,
  SURFACE_CONTRAST_PAIRS,
  SURFACE_SETS,
  surfaceSetFor,
} from './contrast'
import { SurfacePicker } from './SurfacePicker'
import { resolveSurface, SURFACE_CONTROLS, useSurfaceFollow } from './surface'

const css = readFileSync(resolve(process.cwd(), 'src/shared/theme/surfaces.css'), 'utf8')
const sets = parseSurfaceTokens(css)

const REQUIRED_TOKENS = [
  'page-bg',
  'page-fg',
  'page-muted-fg',
  'page-selection-bg',
  'page-find-bg',
  'page-find-current-bg',
  'page-find-ring',
  'page-focus-ring',
  'desk-bg',
]

afterEach(() => {
  cleanup()
  act(() => {
    useStore.getState().bookActions.resetBook()
    useStore.getState().appActions.setColorScheme('light')
  })
  delete document.documentElement.dataset.surface
})

describe('resolveSurface', () => {
  it('auto follows the OS: white in light mode, dark in dark mode', () => {
    expect(resolveSurface('auto', 'light')).toBe('white')
    expect(resolveSurface('auto', 'dark')).toBe('dark')
  })
  it('explicit surfaces ignore the OS (book stays book in both modes)', () => {
    for (const scheme of ['light', 'dark'] as const) {
      expect(resolveSurface('book', scheme)).toBe('book')
      expect(resolveSurface('white', scheme)).toBe('white')
      expect(resolveSurface('dark', scheme)).toBe('dark')
    }
  })
})

describe('surface token sets', () => {
  it('declares the four concrete papers with every required colour token', () => {
    for (const set of SURFACE_SETS) {
      for (const t of REQUIRED_TOKENS) expect(sets[set][t], `${set}: --${t}`).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })
  it('declares shadow, spine, edge and texture tokens for every surface', () => {
    for (const t of ['page-shadow', 'page-edge', 'page-texture', 'spine-shadow', 'spine-width']) {
      expect(css.match(new RegExp(`--${t}:`, 'g'))?.length, `--${t}`).toBeGreaterThanOrEqual(4)
    }
  })
  it('only book has a spine', () => {
    const widths = Array.from(css.matchAll(/--spine-width:\s*([^;]+);/g), (m) => m[1])
    expect(widths).toEqual(['0%', '0%', '11%', '11%'])
  })
  it('the desk is distinct from the page in every surface', () => {
    for (const set of SURFACE_SETS) expect(sets[set]['desk-bg']).not.toBe(sets[set]['page-bg'])
  })
  it('maps surface + OS mode to a set', () => {
    expect(surfaceSetFor('book', 'light')).toBe('book-light')
    expect(surfaceSetFor('book', 'dark')).toBe('book-dark')
    expect(surfaceSetFor('white', 'dark')).toBe('white')
  })
})

describe('every surface meets WCAG AA', () => {
  // The picker can combine any surface with either OS mode; book switches variant with the mode,
  // so all four sets are checked, and each is reachable in light and dark.
  for (const set of SURFACE_SETS) {
    describe(set, () => {
      for (const p of SURFACE_CONTRAST_PAIRS) {
        const min = p.kind === 'text' ? 4.5 : 3
        it(`${p.fg} on ${p.bg} (${p.kind}, ${p.usage}) >= ${min}`, () => {
          expect(contrastRatio(sets[set][p.fg], sets[set][p.bg])).toBeGreaterThanOrEqual(min)
        })
      }
    })
  }
})

describe('useSurfaceFollow', () => {
  it('auto tracks app.colorScheme live; choices override it', () => {
    renderHook(() => useSurfaceFollow())
    const attr = () => document.documentElement.dataset.surface
    expect(attr()).toBe('white')
    act(() => useStore.getState().appActions.setColorScheme('dark'))
    expect(attr()).toBe('dark')
    act(() => useStore.getState().bookActions.setSurface('book'))
    expect(attr()).toBe('book')
    act(() => useStore.getState().appActions.setColorScheme('light'))
    expect(attr()).toBe('book')
    act(() => useStore.getState().bookActions.setSurface('auto'))
    expect(attr()).toBe('white')
  })
})

describe('SurfacePicker', () => {
  it('is a radio group with one radio per surface, the current one checked', () => {
    render(<SurfacePicker />)
    expect(screen.getByRole('radiogroup', { name: 'Paper' })).toHaveAttribute('data-control-id', 'book.surface')
    const radios = screen.getAllByRole('radio')
    expect(radios.map((r) => r.getAttribute('data-control-id'))).toEqual([
      'book.surface.auto',
      'book.surface.book',
      'book.surface.white',
      'book.surface.dark',
    ])
    expect(screen.getByRole('radio', { name: 'Auto' })).toBeChecked()
  })

  it('activating a radio sets book.surface', () => {
    render(<SurfacePicker />)
    fireEvent.click(screen.getByRole('radio', { name: SURFACE_CONTROLS.book.label }))
    expect(useStore.getState().book.surface).toBe('book')
    expect(screen.getByRole('radio', { name: 'Book' })).toBeChecked()
    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }))
    expect(useStore.getState().book.surface).toBe('dark')
    expect(useStore.getState().book.dirty).toBe(true)
  })
})
