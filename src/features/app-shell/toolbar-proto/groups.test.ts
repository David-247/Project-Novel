import { describe, expect, it } from 'vitest'
import { PROTO_GROUPS, PROTO_UNITS, readToolbarProtoFlag } from './groups'

describe('toolbar prototypes (T6 step 1)', () => {
  it('reads the dev flag; anything else keeps the shipping toolbar', () => {
    expect(readToolbarProtoFlag('?toolbar=overflow')).toBe('overflow')
    expect(readToolbarProtoFlag('?toolbar=tabs')).toBe('tabs')
    expect(readToolbarProtoFlag('?toolbar=groups')).toBe('groups')
    expect(readToolbarProtoFlag('?toolbar=ribbon')).toBeNull()
    expect(readToolbarProtoFlag('')).toBeNull()
  })

  it('every group belongs to exactly one "groups" unit', () => {
    for (const g of PROTO_GROUPS) expect(PROTO_UNITS.filter((u) => u.groups.includes(g.label))).toHaveLength(1)
  })
})
