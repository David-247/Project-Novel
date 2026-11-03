import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { isReloadOrNavigationKey, useReloadGuard } from './index'

type Mods = Partial<Record<'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey', boolean>>
const key = (key: string, mods: Mods = {}) => ({
  key,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
})

afterEach(cleanup)

describe('isReloadOrNavigationKey', () => {
  it.each<[string, Mods]>([
    ['F5', {}],
    ['F5', { ctrlKey: true }],
    ['F5', { shiftKey: true }],
    ['r', { ctrlKey: true }],
    ['R', { ctrlKey: true, shiftKey: true }],
    ['ArrowLeft', { altKey: true }],
    ['ArrowRight', { altKey: true }],
    ['BrowserBack', {}],
    ['BrowserForward', {}],
    ['BrowserRefresh', {}],
  ])('Windows/Linux: blocks %s %o', (k, mods) => {
    expect(isReloadOrNavigationKey(key(k, mods), 'other')).toBe(true)
  })

  it.each<[string, Mods]>([
    ['r', { metaKey: true }],
    ['R', { metaKey: true, shiftKey: true }],
    ['F5', {}],
    ['BrowserBack', {}],
  ])('macOS: blocks %s %o', (k, mods) => {
    expect(isReloadOrNavigationKey(key(k, mods), 'mac')).toBe(true)
  })

  it.each<[string, Mods, 'mac' | 'other']>([
    ['r', {}, 'other'], // typing the letter r
    ['R', { shiftKey: true }, 'other'],
    ['r', { metaKey: true }, 'other'], // Win+R is not ours
    ['r', { ctrlKey: true }, 'mac'], // Ctrl+R on macOS is not reload
    ['ArrowLeft', {}, 'other'],
    ['ArrowLeft', { altKey: true }, 'mac'], // Option+Left moves by word on macOS
    ['ArrowRight', { altKey: true, shiftKey: true }, 'other'], // selection
    ['ArrowLeft', { ctrlKey: true }, 'other'], // word left on Windows
    ['s', { ctrlKey: true }, 'other'],
    ['F6', {}, 'other'],
  ])('leaves %s %o (%s) alone', (k, mods, platform) => {
    expect(isReloadOrNavigationKey(key(k, mods), platform)).toBe(false)
  })
})

describe('useReloadGuard', () => {
  const press = (init: KeyboardEventInit) => {
    const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
    document.body.dispatchEvent(e)
    return e
  }

  it('prevents the default of reload / navigation keys at window level, but lets them propagate', () => {
    renderHook(() => useReloadGuard(true))
    let seen = 0
    const listener = () => seen++
    document.addEventListener('keydown', listener)
    expect(press({ key: 'F5' }).defaultPrevented).toBe(true)
    expect(press({ key: 'BrowserBack' }).defaultPrevented).toBe(true)
    expect(press({ key: 'a' }).defaultPrevented).toBe(false)
    expect(seen).toBe(3)
    document.removeEventListener('keydown', listener)

    const back = new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 3 })
    document.body.dispatchEvent(back)
    expect(back.defaultPrevented).toBe(true)
    const primary = new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 })
    document.body.dispatchEvent(primary)
    expect(primary.defaultPrevented).toBe(false)
  })

  it('does nothing when disabled (dev server) and stops guarding on unmount', () => {
    const { rerender, unmount } = renderHook(({ on }) => useReloadGuard(on), { initialProps: { on: false } })
    expect(press({ key: 'F5' }).defaultPrevented).toBe(false)
    rerender({ on: true })
    expect(press({ key: 'F5' }).defaultPrevented).toBe(true)
    unmount()
    expect(press({ key: 'F5' }).defaultPrevented).toBe(false)
  })
})
