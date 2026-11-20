import { afterEach, describe, expect, it } from 'vitest'
import type { Editor } from '@tiptap/core'
import type { Selection } from '@tiptap/pm/state'
import { __resetContextMenuForTests, contextMenuSections, registerContextMenuItems, type ContextMenuContext, type MenuItem } from './registry'

const ctx = { editor: {} as Editor, pos: 3, selection: {} as Selection } satisfies ContextMenuContext
const item = (id: string, order: number, group = 'g'): MenuItem => ({ id, label: id, group, order, run: () => {} })

afterEach(__resetContextMenuForTests)

describe('editor context menu registry', () => {
  it('orders items by `order` and splits them into sections by group (Word: suggestions first)', () => {
    registerContextMenuItems(() => [item('clip.cut', 300, 'clipboard'), item('clip.copy', 310, 'clipboard')])
    registerContextMenuItems(() => [item('spell.the', 0, 'suggestions'), item('spell.ignore', 100, 'proofing'), item('spell.add', 110, 'proofing')])
    expect(contextMenuSections(ctx).map((s) => s.map((i) => i.id))).toEqual([['spell.the'], ['spell.ignore', 'spell.add'], ['clip.cut', 'clip.copy']])
  })

  it('passes the context to every provider; unregistering removes its items', () => {
    const seen: number[] = []
    const off = registerContextMenuItems((c) => {
      seen.push(c.pos)
      return [item('a', 1)]
    })
    expect(contextMenuSections(ctx)).toHaveLength(1)
    expect(seen).toEqual([3])
    off()
    expect(contextMenuSections(ctx)).toEqual([])
  })

  it('a provider that throws loses its items, not the menu', () => {
    registerContextMenuItems(() => {
      throw new Error('boom')
    })
    registerContextMenuItems(() => [item('ok', 1)])
    expect(contextMenuSections(ctx).flat().map((i) => i.id)).toEqual(['ok'])
  })
})
