import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { FIND_CONTROLS, getEditor, HISTORY_CONTROLS, setDocJSON, STYLE_DIALOG_CONTROLS, TOOLBAR_CONTROLS } from '@/features/editor'
import { PAGINATION_CONTROLS } from '@/features/pagination'
import { auditTooltipCoverage, formatCoverageProblems, getTooltipCopy, TOOLTIP_REGISTRY } from '@/features/tooltips'
import { SURFACE_CONTROLS } from '@/shared/theme'
import { useStore } from '@/shared/store'
import { IconButton, Tooltip } from '@/shared/ui'
import { App } from './App'

// Rendered as the web build (not inside Tauri): Tauri-only wiring (menu events, OS theme, close
// prompt) is skipped by the app itself, and none of it renders controls.

beforeAll(() => {
  const rect = { x: 0, y: 0, top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, toJSON: () => ({}) }
  const emptyRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList
  Range.prototype.getClientRects ??= emptyRects
  Range.prototype.getBoundingClientRect ??= () => rect as DOMRect
  Element.prototype.getClientRects ??= emptyRects
  document.elementFromPoint ??= () => null
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

afterEach(() => {
  act(() => useStore.getState().findActions.closePanel())
  act(() => useStore.getState().projectActions.dismissRecoveryPrompt())
  cleanup()
  setDocJSON({ type: 'doc', content: [{ type: 'paragraph' }] })
})

/** Renders the whole app with every conditional control surface (find panel) open. */
async function renderFullApp(extra?: React.ReactNode) {
  const utils = render(
    <>
      <App />
      {extra}
    </>,
  )
  await waitFor(() => expect(getEditor()).not.toBeNull())
  act(() => useStore.getState().findActions.openPanel('night'))
  await screen.findByRole('textbox', { name: FIND_CONTROLS.query.label })
  return utils
}

describe('tooltip coverage (every control in the app has a registered, wired tooltip)', () => {
  it('finds no control without a tooltip in the full app', async () => {
    const { container } = await renderFullApp()
    const rendered = Array.from(container.querySelectorAll('[data-control-id]'), (c) => c.getAttribute('data-control-id'))
    // Sanity: the audit really saw the whole UI (16 formatting, undo/redo, find button, 9 panel
    // controls, the no-project New / Open actions and the page view controls in the status bar).
    const expected = [
      ...Object.values(TOOLBAR_CONTROLS),
      ...Object.values(HISTORY_CONTROLS),
      ...Object.values(FIND_CONTROLS),
      ...Object.values(PAGINATION_CONTROLS),
    ]
    const surfaces = Object.values(SURFACE_CONTROLS).map((m) => m.id)
    expect(new Set(rendered)).toEqual(
      new Set([...expected.map((m) => m.id), ...surfaces, 'book.trimSize', 'book.headerFooter', 'settings.open', 'insert.menu', 'footnote.options', 'file.new_project', 'file.open_project']),
    )
    const problems = auditTooltipCoverage(document.body)
    expect(problems, formatCoverageProblems(problems)).toEqual([])
  })

  it.each([
    [{ kind: 'restore', savedAt: '2026-11-03T10:00:00Z' } as const, ['recovery.decideLater', 'recovery.discard', 'recovery.restore']],
    [{ kind: 'reopen', path: '/books/novel', name: 'My Novel' } as const, ['recovery.reopenClose', 'recovery.dismiss', 'recovery.reopen']],
  ])('covers the crash-recovery dialog (%o), which portals into document.body', async (prompt, ids) => {
    await renderFullApp()
    act(() => useStore.getState().projectActions.showRecoveryPrompt(prompt))
    const dialog = await screen.findByRole('dialog')
    expect(Array.from(dialog.querySelectorAll('[data-control-id]'), (c) => c.getAttribute('data-control-id'))).toEqual(ids)
    const problems = auditTooltipCoverage(document.body)
    expect(problems, formatCoverageProblems(problems)).toEqual([])
    // Registry titles match the visible labels / accessible names.
    for (const el of Array.from(dialog.querySelectorAll('button[data-control-id]'))) {
      const name = el.getAttribute('aria-label') ?? el.textContent!.trim()
      expect(getTooltipCopy(el.getAttribute('data-control-id')!)!.title).toBe(name)
    }
  })

  it('covers the no-project state: New / Open, and Save as project once text was typed', async () => {
    const { container } = await renderFullApp()
    const statusBar = container.querySelector('footer[aria-label="Status bar"]')!
    // Project actions (the page view controls always follow them).
    const ids = () =>
      Array.from(statusBar.querySelectorAll('[data-control-id]'), (c) => c.getAttribute('data-control-id')).filter(
        (id) => !id!.startsWith('pagination.'),
      )
    expect(ids()).toEqual(['file.new_project', 'file.open_project'])
    expect(statusBar).toHaveTextContent('No project open')
    act(() => {
      getEditor()!.commands.insertContent('First words.')
    })
    expect(ids()).toEqual(['file.save', 'file.new_project', 'file.open_project'])
    expect(statusBar).toHaveTextContent('Not saved yet — choose Save as project to keep your work')
    const problems = auditTooltipCoverage(document.body)
    expect(problems, formatCoverageProblems(problems)).toEqual([])
    expect(screen.getByRole('button', { name: 'Save as project…' })).toHaveAccessibleDescription(
      /With no project open, choose a folder\./,
    )
  })

  it('covers the "Backup available — Restore…" status-bar control (unanswered backup, prompt closed)', async () => {
    const { container } = await renderFullApp()
    act(() => useStore.getState().projectActions.setPendingRecovery('2026-11-03T10:00:00Z'))
    const button = screen.getByRole('button', { name: 'Backup available — Restore…' })
    expect(button).toHaveAttribute('data-control-id', 'recovery.reopenPrompt')
    expect(container.querySelector('footer')).toContainElement(button)
    const problems = auditTooltipCoverage(document.body)
    expect(problems, formatCoverageProblems(problems)).toEqual([])
    act(() => useStore.getState().projectActions.setPendingRecovery(null))
  })

  it('covers the Modify style and Manage styles dialogs (incl. rename and delete confirmation)', async () => {
    await renderFullApp()
    act(() => useStore.getState().findActions.closePanel())
    const audit = () => {
      const problems = auditTooltipCoverage(document.body)
      expect(problems, formatCoverageProblems(problems)).toEqual([])
    }
    // Manage styles: create a custom style (opens the rename form), then ask to delete it.
    act(() => void fireEvent.click(document.querySelector('[data-control-id="styles.manage"]')!))
    const manage = await screen.findByRole('dialog', { name: 'Manage styles' })
    act(() => void fireEvent.click(manage.querySelector('[data-control-id="styles.manage.new"]')!))
    expect(manage.querySelector('[data-control-id="styles.manage.renameField"]')).not.toBeNull()
    audit()
    act(() => void fireEvent.click(manage.querySelector('[data-control-id="styles.manage.delete"]')!))
    expect(manage.querySelector('[data-control-id="styles.manage.deleteConfirm"]')).not.toBeNull()
    audit()
    // Modify (stacked over Manage) for the custom style: every field of a custom style is shown.
    act(() => void fireEvent.click(manage.querySelector('[data-control-id="styles.manage.modify"]')!))
    const modify = await screen.findByRole('dialog', { name: /^Modify style/ })
    const fieldIds = Object.values(STYLE_DIALOG_CONTROLS)
      .map((m) => m.id)
      .filter((id) => id.startsWith('styles.field.'))
    for (const id of fieldIds) expect(modify.querySelector(`[data-control-id="${id}"]`), id).not.toBeNull()
    audit()
    act(() => useStore.getState().bookActions.resetBook())
  })

  it('covers the Footnote options dialog and the footnote editor', async () => {
    await renderFullApp()
    act(() => useStore.getState().findActions.closePanel())
    const audit = () => {
      const problems = auditTooltipCoverage(document.body)
      expect(problems, formatCoverageProblems(problems)).toEqual([])
    }
    act(() => void fireEvent.click(document.querySelector('[data-control-id="footnote.options"]')!))
    const dialog = await screen.findByRole('dialog', { name: 'Footnote options' })
    expect(Array.from(dialog.querySelectorAll('[data-control-id]'), (c) => c.getAttribute('data-control-id'))).toEqual([
      'footnote.options.close',
      'footnote.options.numbering',
      'footnote.options.format',
      'footnote.options.separator',
      'footnote.options.done',
    ])
    audit()
    act(() => void fireEvent.change(dialog.querySelector('[data-control-id="footnote.options.numbering"]')!, { target: { value: 'chapter' } }))
    expect(useStore.getState().book.footnotes).toEqual({ numbering: 'chapter' })
    act(() => void fireEvent.click(dialog.querySelector('[data-control-id="footnote.options.done"]')!))
    // The footnote editor (popover) opened by Insert > Footnote.
    act(() => void getEditor()!.commands.insertFootnote())
    await screen.findByTestId('footnote-popover')
    expect(document.querySelector('[data-control-id="footnote.done"]')).not.toBeNull()
    audit()
    act(() => useStore.getState().bookActions.resetBook())
  })

  it('covers the Headers & page numbers dialog (custom header text fields included)', async () => {
    await renderFullApp()
    act(() => useStore.getState().findActions.closePanel())
    act(() => void fireEvent.click(document.querySelector('[data-control-id="book.headerFooter"]')!))
    const dialog = await screen.findByRole('dialog', { name: 'Headers & page numbers' })
    for (const sel of ['book.headerFooter.verso', 'book.headerFooter.recto']) {
      act(() => void fireEvent.change(dialog.querySelector(`[data-control-id="${sel}"]`)!, { target: { value: 'custom' } }))
    }
    const ids = Array.from(dialog.querySelectorAll('[data-control-id]'), (c) => c.getAttribute('data-control-id'))
    for (const id of [
      'book.headerFooter.verso',
      'book.headerFooter.versoText',
      'book.headerFooter.recto',
      'book.headerFooter.rectoText',
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
    ]) {
      expect(ids, id).toContain(id)
    }
    const problems = auditTooltipCoverage(document.body)
    expect(problems, formatCoverageProblems(problems)).toEqual([])
    act(() => void fireEvent.click(dialog.querySelector('[data-control-id="book.headerFooter.done"]')!))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Headers & page numbers' })).toBeNull())
    act(() => useStore.getState().bookActions.resetBook())
  })

  it('NEGATIVE: fails for a button with no tooltip entry', async () => {
    await renderFullApp(
      <>
        <button type="button">Mystery action</button>
        <button type="button" data-control-id="nowhere.registered">
          Unregistered
        </button>
        {/* Registered id, but the call site forgot to wrap it in <Tooltip>. */}
        <IconButton label="Bold again" data-control-id={TOOLBAR_CONTROLS.bold.id}>
          B
        </IconButton>
        {/* Wrapped, but the id is unknown: Tooltip renders the bare control. */}
        <Tooltip>
          <IconButton label="Wrapped unknown" data-control-id="nowhere.either">
            ?
          </IconButton>
        </Tooltip>
      </>,
    )
    const problems = auditTooltipCoverage(document.body)
    expect(problems.map((p) => [p.reason, p.controlId])).toEqual([
      ['missing-id', null],
      ['unregistered', 'nowhere.registered'],
      ['not-wired', TOOLBAR_CONTROLS.bold.id],
      ['unregistered', 'nowhere.either'],
    ])
  })

  it('every rendered control id resolves through the provider lookup', async () => {
    const { container } = await renderFullApp()
    for (const el of Array.from(container.querySelectorAll('[data-control-id]'))) {
      expect(getTooltipCopy(el.getAttribute('data-control-id')!), el.outerHTML.slice(0, 80)).toBeDefined()
    }
  })
})

describe('tooltip registry', () => {
  it('has a title and a one-line description for every entry', () => {
    for (const [id, copy] of Object.entries(TOOLTIP_REGISTRY)) {
      expect(copy.title, id).toMatch(/\S/)
      expect(copy.description, id).toMatch(/^[^\n]+\.$/)
      expect(copy.description!.length, id).toBeLessThanOrEqual(100)
    }
  })

  it('derives titles and shortcuts from the editor control metadata (one source of truth)', () => {
    for (const meta of [
      ...Object.values(TOOLBAR_CONTROLS),
      ...Object.values(HISTORY_CONTROLS),
      ...Object.values(FIND_CONTROLS),
      ...Object.values(STYLE_DIALOG_CONTROLS),
    ]) {
      const copy = getTooltipCopy(meta.id)!
      expect(copy.title).toBe(meta.label)
      expect(copy.shortcut).toEqual('shortcut' in meta ? meta.shortcut : undefined)
    }
  })

  it('registers the project file actions and the recovery controls', () => {
    for (const id of [
      'file.new_project',
      'file.open_project',
      'file.open_recent',
      'file.save',
      'recovery.restore',
      'recovery.discard',
      'recovery.decideLater',
      'recovery.reopenPrompt',
      'recovery.reopen',
      'recovery.dismiss',
      'recovery.reopenClose',
      'dialog.close',
    ]) {
      expect(getTooltipCopy(id), id).toBeDefined()
    }
    expect(getTooltipCopy('constructor')).toBeUndefined()
  })
})
