import { useEffect } from 'react'
import { useStore } from './index'

/** Keeps `app.colorScheme` in sync with the OS preference. Call once at the root. */
export function useColorSchemeSync(): void {
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => useStore.getState().appActions.setColorScheme(mq.matches ? 'dark' : 'light')
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [])
}
