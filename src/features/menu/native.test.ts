import { afterEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))
vi.mock('@tauri-apps/api/event', () => ({ listen: () => Promise.resolve(() => {}) }))

import { COMMAND_STATE_DEBOUNCE_MS, notifyCommandStateChanged } from '@/shared/commands'
import { startNativeMenu } from './native'

afterEach(() => {
  vi.useRealTimers()
  invoke.mockReset()
})

describe('native menu snapshot', () => {
  it('resends an identical snapshot after a failed menu_set (review UI #7)', async () => {
    vi.useFakeTimers()
    invoke.mockRejectedValueOnce(new Error('window closing')).mockResolvedValue(undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const stop = startNativeMenu({ force: true })
    await vi.advanceTimersByTimeAsync(50)
    expect(invoke).toHaveBeenCalledTimes(1)
    // Nothing changed, but the last send failed: the next state signal sends it again.
    notifyCommandStateChanged()
    await vi.advanceTimersByTimeAsync(COMMAND_STATE_DEBOUNCE_MS + 10)
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(invoke.mock.calls[1][0]).toBe('menu_set')
    // Sent and applied: an identical snapshot is not sent again.
    notifyCommandStateChanged()
    await vi.advanceTimersByTimeAsync(COMMAND_STATE_DEBOUNCE_MS + 10)
    expect(invoke).toHaveBeenCalledTimes(2)
    stop()
    warn.mockRestore()
  })
})
