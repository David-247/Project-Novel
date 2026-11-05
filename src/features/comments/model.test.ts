import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { contrastRatio } from '@/shared/theme'
import { parseSurfaceTokens, SURFACE_SETS } from '@/shared/theme/contrast'
import { buildHighlightCss, highlightFor } from './highlight'
import { inRange, needsDrawer, spreadRange, stackCards } from './layout'
import {
  createThread,
  parseCommentsFile,
  relativeDate,
  serializeCommentsFile,
  withEditedMessage,
  withoutMessage,
  withReply,
  withResolved,
} from './model'

const author = { name: 'Ada', color: '#c0392b' }

describe('comments.json model', () => {
  it('round-trips threads and keeps unknown keys at every level', () => {
    const file = {
      version: 1,
      later: { keep: true },
      threads: [
        {
          id: 't1',
          createdAt: '2026-11-01T10:00:00.000Z',
          author: 'Ada',
          authorColor: '#c0392b',
          resolved: true,
          resolvedBy: 'Ada',
          resolvedAt: '2026-11-02T10:00:00.000Z',
          mood: 'happy',
          messages: [{ id: 'm1', author: 'Ada', date: '2026-11-01T10:00:00.000Z', text: 'Line one\nline two', reactions: [1] }],
        },
      ],
    }
    const parsed = parseCommentsFile(file)
    expect(parsed.threads[0].messages[0].text).toBe('Line one\nline two')
    expect(serializeCommentsFile(parsed)).toEqual(file)
  })

  it('keeps entries it cannot read verbatim and flags a newer version', () => {
    const odd = { id: 'has space', messages: [] }
    const parsed = parseCommentsFile({ version: 3, threads: [odd, { id: 'ok', messages: [{ id: 'm', text: 'x' }] }] })
    expect(parsed.newer).toBe(3)
    expect(parsed.threads.map((t) => t.id)).toEqual(['ok'])
    expect(serializeCommentsFile(parsed).threads).toEqual([expect.objectContaining({ id: 'ok' }), odd])
    expect(serializeCommentsFile(parsed).version).toBe(1)
  })

  it('a threads value that is not a list is refused (the file is then guarded as damaged)', () => {
    expect(() => parseCommentsFile({ version: 1, threads: {} })).toThrow()
  })

  it('thread changes are pure and keep the rest', () => {
    const t = createThread('t', author, 'Hi', '2026-11-01T00:00:00.000Z')
    expect(t).toMatchObject({ author: 'Ada', authorColor: '#c0392b', resolved: false })
    const r = withReply(t, { name: 'Bo' }, 'Reply')
    expect(r.messages.map((m) => m.author)).toEqual(['Ada', 'Bo'])
    expect(t.messages).toHaveLength(1)
    const e = withEditedMessage(r, r.messages[1].id, 'Edited')!
    expect(e.messages[1]).toMatchObject({ text: 'Edited', editedAt: expect.any(String) })
    expect(withEditedMessage(e, e.messages[1].id, 'Edited')).toBeNull()
    expect(withoutMessage(e, e.messages[0].id)).toBeNull()
    expect(withoutMessage(e, e.messages[1].id)!.messages).toHaveLength(1)
    const done = withResolved(t, true, 'Bo')
    expect(done).toMatchObject({ resolved: true, resolvedBy: 'Bo' })
    expect(withResolved(done, false, 'Bo')).toEqual({ ...t, resolved: false })
  })

  it('relative dates', () => {
    const now = Date.parse('2026-11-04T12:00:00Z')
    expect(relativeDate('2026-11-04T11:59:40Z', now)).toBe('just now')
    expect(relativeDate('2026-11-04T11:55:00Z', now)).toBe('5 min ago')
    expect(relativeDate('2026-11-04T09:00:00Z', now)).toBe('3 h ago')
    expect(relativeDate('2026-11-03T09:00:00Z', now)).toBe('yesterday')
  })
})

describe('margin layout', () => {
  it('cards sit level with their anchors and stack downward without overlap', () => {
    expect(stackCards([{ desired: 0, height: 50 }, { desired: 20, height: 50 }, { desired: 300, height: 50 }])).toEqual([0, 58, 300])
  })

  it('the active card is pulled to its anchor; the ones above stack upward', () => {
    const items = [
      { desired: 100, height: 50 },
      { desired: 110, height: 50 },
      { desired: 120, height: 50 },
    ]
    expect(stackCards(items, 2)).toEqual([4, 62, 120])
    // Not enough room above: laid out downward from the top instead.
    expect(stackCards([{ desired: 0, height: 80 }, { desired: 10, height: 50 }], 1)).toEqual([0, 88])
  })

  it('the visible spread is the page range of the layout model', () => {
    const pages = [0, 1, 2].map((i) => ({ index: i, side: i % 2 ? 'verso' : 'recto', from: i * 100, to: i * 100 + 100, isBlank: false, startsBlockType: null, chapterIndex: -1 }) as const)
    const r = spreadRange(pages, { index: 1, first: 1, last: 2 })
    expect(r).toEqual({ from: 100, to: Infinity })
    expect(inRange(50, r)).toBe(false)
    expect(inRange(150, r)).toBe(true)
    expect(spreadRange(pages, { index: 0, first: 0, last: 0 })).toEqual({ from: 0, to: 100 })
    expect(inRange(5, null)).toBe(true)
  })

  it('switches to the drawer when the pages plus the panel do not fit', () => {
    expect(needsDrawer(1280, 528, 'spread')).toBe(false)
    expect(needsDrawer(900, 528, 'spread')).toBe(true)
    expect(needsDrawer(900, 528, 'single')).toBe(false)
  })
})

describe('anchor highlight contrast (AA on all four papers)', () => {
  const surfaces = parseSurfaceTokens(readFileSync(resolve(process.cwd(), 'src/shared/theme/surfaces.css'), 'utf8'))
  const comments = parseSurfaceTokens(readFileSync(resolve(process.cwd(), 'src/features/comments/comments.css'), 'utf8').replace(/^:root,\n/m, ''))
  const palette = ['#c0392b', '#2e86c1', '#f1c40f', '#27ae60', '#8e44ad', '#000000', '#ffffff', '#ff00ff']
  for (const set of SURFACE_SETS) {
    it(`${set}: page text on the highlight fills, the active underline against paper and fills`, () => {
      const page = surfaces[set]
      const c = comments[set]
      expect(contrastRatio(page['page-fg'], c['page-comment-bg'])).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(page['page-fg'], c['page-comment-active-bg'])).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(c['page-comment-ring'], page['page-bg'])).toBeGreaterThanOrEqual(3)
      expect(contrastRatio(c['page-comment-ring'], c['page-comment-active-bg'])).toBeGreaterThanOrEqual(3)
      for (const color of palette) {
        expect(contrastRatio(page['page-fg'], highlightFor(color, page['page-bg'], page['page-fg']))).toBeGreaterThanOrEqual(4.5)
      }
    })
  }

  it('the style sheet colours threads by author, hides resolved ones and lights the active one', () => {
    const t = (id: string, color: string | null, resolved = false) => ({ ...createThread(id, { name: 'A', color }, 'x'), resolved })
    const css = buildHighlightCss({
      threads: [t('a', '#c0392b'), t('b', '#c0392b'), t('r', null, true), t('n', null)],
      activeId: 'n',
      hoverId: null,
      showResolved: false,
      pageBg: '#ffffff',
      pageFg: '#1b1d1f',
    })
    expect(css).toMatch(/\.nv-comment:is\(\[data-comment-id="a"\],\[data-comment-id="b"\]\)\{background-color:#[0-9a-f]{6}\}/)
    expect(css).toContain(':root .nv-comment[data-comment-id="r"]{background-color:transparent}')
    expect(css).toContain(':root .nv-comment[data-comment-id="n"][data-comment-id]{background-color:var(--page-comment-active-bg)')
  })
})
