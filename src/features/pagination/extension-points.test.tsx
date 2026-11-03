import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getSchema } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Heading from '@tiptap/extension-heading'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import { Node } from '@tiptap/core'
import { DEFAULT_MARGINS } from '@/shared/book'
import type { PageInfo } from '@/shared/store'
import {
  defaultChapterPredicate,
  hasReservations,
  isChapterStart,
  onInvalidate,
  registerBottomReservation,
  registerPageSlot,
  setChapterPredicate,
  totalReservation,
} from './extension-points'
import { resolvePageGeometry } from './geometry'
import { blockBreakBefore } from './measure'
import { PageFrames } from './PageFrames'
import { placePages } from './placement'

const g = resolvePageGeometry('us-5.5x8.5', DEFAULT_MARGINS)
const page = (index: number, extra: Partial<PageInfo> = {}): PageInfo => ({
  index,
  side: index % 2 === 0 ? 'recto' : 'verso',
  from: index * 10,
  to: index * 10 + 10,
  isBlank: false,
  startsBlockType: null,
  chapterIndex: 0,
  ...extra,
})

/** Fixture node standing in for the chapter / page-break ticket's nodes: carries `breakBefore`. */
const PageBreakFixture = Node.create({
  name: 'pageBreakFixture',
  group: 'block',
  content: 'inline*',
  addAttributes: () => ({ breakBefore: { default: null } }),
  parseHTML: () => [{ tag: 'section' }],
  renderHTML: ({ HTMLAttributes }) => ['section', HTMLAttributes, 0],
})
const schema = getSchema([Document, Paragraph, Text, Heading, PageBreakFixture])

describe('header / footer page slots', () => {
  const cleanups: (() => void)[] = []
  afterEach(() => {
    cleanups.splice(0).forEach((c) => c())
    cleanup()
  })

  it('renders registered slots in every rendered page with the page model', () => {
    cleanups.push(
      registerPageSlot({ id: 'folio', region: 'footer', render: ({ page }) => <span>folio {page.index + 1}</span> }),
      registerPageSlot({
        id: 'head',
        region: 'header',
        render: ({ page, pageCount, width, height }) => (
          <span>
            head {page.side} {pageCount} {Math.round(width)}x{Math.round(height)}
          </span>
        ),
      }),
    )
    const pages = [page(0), page(1), page(2)]
    render(<PageFrames placement={placePages(3, g, 'spread')} pages={pages} geometry={g} firstRow={0} lastRow={5} />)
    expect(screen.getByText('folio 1')).toBeInTheDocument()
    expect(screen.getByText('folio 3')).toBeInTheDocument()
    expect(screen.getByText(`head verso 3 ${Math.round(g.contentWidth)}x${g.margins.top}`)).toBeInTheDocument()
    // Slot regions sit inside the margins, over the text block width.
    const footer = screen.getByText('folio 2').closest('.nv-slot') as HTMLElement
    expect(footer.style.height).toBe(`${g.margins.bottom}px`)
    expect(footer.style.left).toBe(`${g.margins.outside}px`)
  })

  it('virtualises: rows outside the window render nothing; unregister removes the slot', () => {
    const off = registerPageSlot({ id: 'folio', region: 'footer', render: ({ page }) => `f${page.index}` })
    const pages = Array.from({ length: 9 }, (_, i) => page(i))
    const { container, rerender } = render(
      <PageFrames placement={placePages(9, g, 'spread')} pages={pages} geometry={g} firstRow={1} lastRow={1} />,
    )
    expect([...container.querySelectorAll('.nv-page')].map((e) => e.getAttribute('data-page-index'))).toEqual(['1', '2'])
    off()
    rerender(<PageFrames placement={placePages(9, g, 'spread')} pages={pages} geometry={g} firstRow={1} lastRow={1} />)
    expect(container.querySelector('.nv-slot')).toBeNull()
  })

  it('orders slots in a region and replaces a slot registered twice', () => {
    cleanups.push(
      registerPageSlot({ id: 'b', region: 'header', order: 2, render: () => 'second' }),
      registerPageSlot({ id: 'a', region: 'header', order: 1, render: () => 'old' }),
      registerPageSlot({ id: 'a', region: 'header', order: 1, render: () => 'first' }),
    )
    const { container } = render(
      <PageFrames placement={placePages(1, g, 'spread')} pages={[page(0)]} geometry={g} firstRow={0} lastRow={0} />,
    )
    expect(container.querySelector('.nv-slot-header')!.textContent).toBe('firstsecond')
  })
})

describe('bottom reservations', () => {
  it('sums registered reservations, ignores bad answers, and reflows on (un)register', () => {
    const reflow = vi.fn()
    const offInvalidate = onInvalidate(reflow)
    const p = { index: 0, side: 'recto' as const, from: 0, to: 50 }
    const a = registerBottomReservation('notes', (pg) => (pg.from <= 10 && 10 < pg.to ? 40 : 0))
    const b = registerBottomReservation('bad', () => Number.NaN)
    expect(hasReservations()).toBe(true)
    expect(totalReservation(p)).toBe(40)
    expect(totalReservation({ ...p, from: 20 })).toBe(0)
    a()
    b()
    expect(hasReservations()).toBe(false)
    expect(reflow).toHaveBeenCalledTimes(4)
    offInvalidate()
  })
})

describe('chapters and the breakBefore contract', () => {
  it('a level-1 heading opens a chapter by default; the predicate is replaceable', () => {
    const h1 = schema.nodes.heading.create({ level: 1 })
    const h2 = schema.nodes.heading.create({ level: 2 })
    expect(isChapterStart(h1)).toBe(true)
    expect(isChapterStart(h2)).toBe(false)
    setChapterPredicate((n) => n.type.name === 'pageBreakFixture')
    expect(isChapterStart(h1)).toBe(false)
    setChapterPredicate(null)
    expect(defaultChapterPredicate(h1)).toBe(true)
    expect(isChapterStart(h1)).toBe(true)
  })

  it('reads the node attr first, then the data-break-before DOM attribute', () => {
    const recto = schema.nodes.pageBreakFixture.create({ breakBefore: 'recto' })
    const plain = schema.nodes.paragraph.create()
    const el = document.createElement('p')
    expect(blockBreakBefore(recto, el)).toBe('recto')
    expect(blockBreakBefore(plain, el)).toBeNull()
    el.setAttribute('data-break-before', 'page')
    expect(blockBreakBefore(plain, el)).toBe('page')
    // The node attribute wins over the DOM.
    expect(blockBreakBefore(recto, el)).toBe('recto')
    el.setAttribute('data-break-before', 'sideways')
    expect(blockBreakBefore(plain, el)).toBeNull()
    expect(blockBreakBefore(schema.nodes.pageBreakFixture.create({ breakBefore: 'nope' }), null)).toBeNull()
  })
})
