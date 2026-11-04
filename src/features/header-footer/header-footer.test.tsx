import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { auditTooltipCoverage, formatCoverageProblems, getTooltipCopy, TOOLTIP_REGISTRY } from '@/features/tooltips'
import { defaultHeaderFooter } from '@/shared/book'
import { useStore } from '@/shared/store'
import { TooltipProvider } from '@/shared/ui'
import { HEADER_FOOTER_CONTROLS } from './controls'
import { HeaderFooter, HeaderFooterButton, closeHeaderFooterDialog } from './index'

vi.mock('@/features/storage', () => ({ updateProjectDetails: vi.fn(async () => true) }))

const ids = (root: ParentNode) => Array.from(root.querySelectorAll('[data-control-id]'), (c) => c.getAttribute('data-control-id'))

function app() {
  return render(
    <TooltipProvider lookup={getTooltipCopy}>
      <HeaderFooterButton />
      <HeaderFooter />
    </TooltipProvider>,
  )
}

beforeEach(() => {
  useStore.getState().bookActions.resetBook()
  useStore.getState().projectActions.projectOpened({ path: '/p', title: 'My Novel', author: 'Ada' })
})
afterEach(() => {
  act(() => closeHeaderFooterDialog())
  cleanup()
  useStore.getState().projectActions.projectClosed()
})

describe('Headers & page numbers dialog', () => {
  it('registers a tooltip for every control id', () => {
    for (const meta of Object.values(HEADER_FOOTER_CONTROLS)) {
      expect(TOOLTIP_REGISTRY[meta.id], meta.id).toBeDefined()
      expect(TOOLTIP_REGISTRY[meta.id].title).toBe(meta.label)
    }
  })

  it('opens from the toolbar button; every control has a wired tooltip', async () => {
    app()
    fireEvent.click(screen.getByRole('button', { name: 'Headers & page numbers' }))
    const dialog = await screen.findByRole('dialog', { name: 'Headers & page numbers' })
    expect(ids(dialog)).toEqual(
      expect.arrayContaining([
        'book.headerFooter.verso',
        'book.headerFooter.recto',
        'book.headerFooter.numberPosition',
        'book.headerFooter.numberFormat',
        'book.headerFooter.numberStart',
        'book.headerFooter.frontMatter',
        'book.headerFooter.restart',
        'book.headerFooter.suppressHeader',
        'book.headerFooter.suppressNumber',
        'book.headerFooter.suppressBlank',
        'book.details',
        'book.headerFooter.done',
      ]),
    )
    const problems = auditTooltipCoverage(document.body)
    expect(problems, formatCoverageProblems(problems)).toEqual([])
  })

  it('applies each change to book.headerFooter at once, and marks the book unsaved', async () => {
    app()
    fireEvent.click(screen.getByRole('button', { name: 'Headers & page numbers' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(screen.getByLabelText('Left-hand pages show'), { target: { value: 'custom' } })
    fireEvent.change(screen.getByLabelText('Left-hand custom text'), { target: { value: 'Hi' } })
    fireEvent.change(screen.getByLabelText('Page numbers'), { target: { value: 'footer-outside' } })
    fireEvent.change(screen.getByLabelText('Front matter numbers'), { target: { value: 'roman' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Nothing on blank pages' }))
    const s = useStore.getState().book
    expect(s.headerFooter).toEqual({
      ...defaultHeaderFooter(),
      verso: { kind: 'custom', text: 'Hi' },
      pageNumber: { position: 'footer-outside', format: 'arabic', start: 1 },
      frontMatter: 'roman',
      suppressOnBlank: false,
    })
    expect(s.dirty).toBe(true)
    expect(dialog).toBeInTheDocument()
  })

  it('the starting number accepts whole numbers only and snaps back on blur', async () => {
    app()
    fireEvent.click(screen.getByRole('button', { name: 'Headers & page numbers' }))
    const start = await screen.findByLabelText('Starting number')
    fireEvent.change(start, { target: { value: '12' } })
    expect(useStore.getState().book.headerFooter.pageNumber.start).toBe(12)
    fireEvent.change(start, { target: { value: 'x' } })
    expect(start).toHaveAttribute('aria-invalid', 'true')
    expect(useStore.getState().book.headerFooter.pageNumber.start).toBe(12)
    fireEvent.blur(start)
    expect(start).toHaveValue('12')
  })

  it('the preview resolves with the same function as the pages (author on verso, title on recto, numbers 2 and 3)', async () => {
    app()
    fireEvent.click(screen.getByRole('button', { name: 'Headers & page numbers' }))
    const preview = await screen.findByTestId('hf-preview')
    const text = (page: number, what: string) => preview.querySelector(`[data-preview-page="${page}"] [data-hf="${what}"]`)?.textContent
    expect(text(3, 'text')).toBe('Ada')
    expect(text(4, 'text')).toBe('My Novel')
    expect(text(3, 'number')).toBe('2')
    expect(text(4, 'number')).toBe('3')
    expect(text(2, 'number')).toBeUndefined() // the chapter opening
    act(() => useStore.getState().bookActions.setHeaderFooter((h) => ({ ...h, pageNumber: { ...h.pageNumber, format: 'lower-roman' } })))
    expect(text(4, 'number')).toBe('iii')
  })

  it('Book details saves through storage, returns to the headers dialog, and is disabled without a project', async () => {
    const storage = await import('@/features/storage')
    app()
    fireEvent.click(screen.getByRole('button', { name: 'Headers & page numbers' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Book details…' }))
    const details = await screen.findByRole('dialog', { name: 'Book details' })
    const problems = auditTooltipCoverage(document.body)
    expect(problems, formatCoverageProblems(problems)).toEqual([])
    const author = screen.getByLabelText('Author')
    fireEvent.change(author, { target: { value: 'New Name' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save details' }))
    expect(storage.updateProjectDetails).toHaveBeenCalledWith({ title: 'My Novel', author: 'New Name' })
    expect(await screen.findByRole('dialog', { name: 'Headers & page numbers' })).toBeInTheDocument()
    expect(details).not.toBeInTheDocument()

    act(() => useStore.getState().projectActions.projectClosed())
    expect(screen.getByRole('button', { name: 'Book details…' })).toBeDisabled()
  })
})
