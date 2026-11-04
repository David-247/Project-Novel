import { describe, expect, it, vi } from 'vitest'
import {
  createMemoryDocumentProvider,
  emptyDoc,
  getDocumentProvider,
  isEmptyDocJSON,
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
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('memory provider markClean(version) ignores stale versions', () => {
    const p = createMemoryDocumentProvider()
    p.update({ type: 'doc', content: [] })
    const v = p.getDocVersion()
    p.update({ type: 'doc' })
    p.markClean(v)
    expect(p.isDirty()).toBe(true)
    p.markClean(p.getDocVersion())
    expect(p.isDirty()).toBe(false)
  })
})

describe('isEmptyDocJSON', () => {
  it('is true only for a document holding one empty paragraph or heading (or nothing)', () => {
    expect(isEmptyDocJSON(emptyDoc())).toBe(true)
    expect(isEmptyDocJSON({ type: 'doc' })).toBe(true)
    expect(isEmptyDocJSON({ type: 'doc', content: [{ type: 'heading', attrs: { level: 1 } }] })).toBe(true)
    expect(isEmptyDocJSON({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }] })).toBe(false)
    expect(isEmptyDocJSON({ type: 'doc', content: [{ type: 'paragraph' }, { type: 'paragraph' }] })).toBe(false)
    expect(isEmptyDocJSON({ type: 'doc', content: [{ type: 'pageBreak' }] })).toBe(false)
  })
})
