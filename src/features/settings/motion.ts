import { useEffect, useSyncExternalStore } from 'react'
import { useStore } from '@/shared/store'
import type { ReduceMotion } from '@/shared/store'

const QUERY = '(prefers-reduced-motion: reduce)'

function systemPrefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(QUERY).matches
}

/** Whether motion should be reduced: the preference, with 'system' resolved against the OS setting. */
export function resolveReduceMotion(pref: ReduceMotion, systemReduces: boolean): boolean {
  return pref === 'on' ? true : pref === 'off' ? false : systemReduces
}

/** Non-React `prefersReducedMotion()`: for animations driven from code (the page turn). */
export function prefersReducedMotion(): boolean {
  return resolveReduceMotion(useStore.getState().preferences.reduceMotion, systemPrefersReducedMotion())
}

function subscribeSystem(cb: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {}
  const mq = window.matchMedia(QUERY)
  mq.addEventListener('change', cb)
  return () => mq.removeEventListener('change', cb)
}

/** Reactive `prefersReducedMotion()`. */
export function useReducedMotion(): boolean {
  const pref = useStore((s) => s.preferences.reduceMotion)
  const system = useSyncExternalStore(subscribeSystem, systemPrefersReducedMotion, () => false)
  return resolveReduceMotion(pref, system)
}

/**
 * Mirrors the Motion preference on `<html data-reduce-motion="on">` while motion is reduced, so CSS
 * (index.css) can stop CSS animations and transitions app-wide. 'Allow motion' removes it; CSS that
 * already honours the OS setting (`motion-safe:`) is unchanged by it.
 */
export function useReduceMotionAttribute(): void {
  const reduce = useReducedMotion()
  useEffect(() => {
    const root = document.documentElement
    if (reduce) root.dataset.reduceMotion = 'on'
    else delete root.dataset.reduceMotion
  }, [reduce])
}
