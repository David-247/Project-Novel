import { describe, expect, it, vi } from 'vitest'
import {
  createMemoryDocumentProvider,
  emptyDoc,
  getDocumentProvider,
  onDocumentProviderChange,
  registerDocumentProvider,
} from './document'

describe('document provider registry', () => {
  it('registers, notifies and unregisters', () => {
    const cb = vi.fn()
    const off = onDocumentProviderChange(cb)
    const p = createMemoryDocumentProvider()
    const unregister = registerDocumentProvider(p)
    expect(getDocumentProvider()).toBe(p)
    expect(cb).toHaveBeenLastCalledWith(p)
    unregister()
    expect(getDocumentProvider()).toBeNull()
    expect(cb).toHaveBeenLastCalledWith(null)
    off()
  })

  it('memory provider tracks dirtiness and changes', () => {
    const p = createMemoryDocumentProvider()
    const changed = vi.fn()
    p.onDocChange(changed)
    expect(p.getDocJSON()).toEqual(emptyDoc())
    p.update({ type: 'doc', content: [] })
    expect(p.isDirty()).toBe(true)
    p.markClean()
    expect(p.isDirty()).toBe(false)
    p.setDocJSON(emptyDoc())
    expect(p.isDirty()).toBe(false)
    expect(changed).toHaveBeenCalledTimes(2)
  })
})
