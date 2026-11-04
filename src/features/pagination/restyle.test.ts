import { describe, expect, it } from 'vitest'
import { resolveStyleSheet, type StyleSheetJSON } from '@/shared/book'
import { restyledIds } from './restyle'

const custom = (def: Record<string, unknown>) => ({ builtIn: false, name: 'X', kind: 'chapter', outlineLevel: 1, ...def })

describe('restyledIds (which styles a style edit must re-measure)', () => {
  it('lists styles whose resolved definition changed, and nothing for an identical sheet', () => {
    const a = resolveStyleSheet({})
    expect(restyledIds(a, resolveStyleSheet({}))).toEqual(new Set())
    expect(restyledIds(a, resolveStyleSheet({ body: { fontSize: 12 } })).has('body')).toBe(true)
  })

  it('REGRESSION: a style whose chapter role changes with an unchanged definition is re-measured', () => {
    // A: a copy of Chapter Title (all its settings copied). B: New from A, used after a Chapter Number.
    const titleCopy = resolveStyleSheet({}).get('chapter-title')!
    const { id: _id, name: _name, builtIn: _builtIn, basedOn: _basedOn, ...own } = titleCopy
    void [_id, _name, _builtIn, _basedOn]
    const before: StyleSheetJSON = { a: custom({ ...own, basedOn: 'chapter-title' }), b: custom({ basedOn: 'a' }) }
    // Re-point A's Based on to Body: B resolves the same, but is no longer a chapter title (it loses
    // the number + title group: its break and space before come back).
    const after: StyleSheetJSON = { ...before, a: custom({ ...own, basedOn: 'body' }) }
    const ra = resolveStyleSheet(before)
    const rb = resolveStyleSheet(after)
    expect(JSON.stringify(ra.get('b'))).toBe(JSON.stringify(rb.get('b')))
    const ids = restyledIds(ra, rb)
    expect(ids.has('a')).toBe(true)
    expect(ids.has('b')).toBe(true)
    // The group partner's blocks are re-measured too (role signature changed: every number and title style).
    expect(ids.has('chapter-number')).toBe(true)
    expect(ids.has('chapter-title')).toBe(true)
  })

  it('an edit that changes no role does not re-measure the chapter styles', () => {
    const ids = restyledIds(resolveStyleSheet({}), resolveStyleSheet({ body: { fontSize: 12 } }))
    expect(ids.has('chapter-number')).toBe(false)
  })
})
