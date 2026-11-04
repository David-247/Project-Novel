import { act, cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Button, Checkbox, Dialog, IconButton, TextInput, Tooltip, TooltipProvider } from '.'
import type { TooltipCopy } from '.'
import { ariaKeyshortcut, formatShortcut } from './shortcut'

beforeAll(() => {
  // Radix Popper measures the content; jsdom has no ResizeObserver.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** Pretend the last key press was long ago (keyboard-focus heuristics use performance.now). */
function forgetKeys() {
  const later = performance.now() + 60_000
  vi.spyOn(performance, 'now').mockReturnValue(later)
}

const COPY: Record<string, TooltipCopy> = {
  'x.bold': { title: 'Bold', description: 'Make text bold.', shortcut: 'Mod-b' },
  'x.redo': { title: 'Redo', description: 'Redo it.', shortcut: ['Mod-Shift-z', 'Mod-y'] },
  'x.field': { title: 'Find', description: 'Text to find.' },
  'x.check': { title: 'Match case', description: 'Case matters.' },
}
const lookup = (id: string) => COPY[id]

function tab() {
  // The tooltip only treats focus as keyboard focus for text fields after a Tab press.
  fireEvent.keyDown(window, { key: 'Tab' })
}

describe('formatShortcut / ariaKeyshortcut', () => {
  it('renders Mod as Cmd on macOS and Ctrl elsewhere, from one spec', () => {
    expect(formatShortcut('Mod-b', 'mac')).toBe('⌘B')
    expect(formatShortcut('Mod-b', 'other')).toBe('Ctrl+B')
    expect(formatShortcut('Mod+Shift+Z', 'mac')).toBe('⇧⌘Z')
    expect(formatShortcut('Mod-Shift-8', 'other')).toBe('Ctrl+Shift+8')
    expect(formatShortcut('Mod-[', 'other')).toBe('Ctrl+[')
    expect(formatShortcut('Mod--', 'other')).toBe('Ctrl+-')
    expect(formatShortcut('Shift-Enter', 'mac')).toBe('⇧Return')
    expect(formatShortcut('Escape', 'other')).toBe('Esc')
    expect(ariaKeyshortcut('Mod-b', 'mac')).toBe('Meta+B')
    expect(ariaKeyshortcut('Mod-Shift-z', 'other')).toBe('Control+Shift+Z')
    expect(ariaKeyshortcut('Escape', 'other')).toBe('Escape')
  })

  it('rejects unknown modifiers', () => {
    expect(() => formatShortcut('Hyper-b', 'other')).toThrow(/Unknown modifier/)
  })
})

describe('Tooltip', () => {
  function renderBold(platform: 'mac' | 'other' = 'other') {
    render(
      <TooltipProvider lookup={lookup} platform={platform}>
        <Tooltip>
          <IconButton label="Bold" data-control-id="x.bold">
            B
          </IconButton>
        </Tooltip>
      </TooltipProvider>,
    )
    return screen.getByRole('button', { name: 'Bold' })
  }

  it('links a persistent description (with shortcut) for screen readers and touch, without hovering', () => {
    const button = renderBold()
    const id = button.getAttribute('aria-describedby')!
    expect(document.getElementById(id)).toHaveTextContent('Make text bold. Shortcut: Ctrl+B.')
    expect(button).toHaveAttribute('aria-keyshortcuts', 'Control+B')
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('opens on keyboard focus with title, description and platform shortcut; closes on blur', () => {
    const button = renderBold('mac')
    tab()
    act(() => button.focus())
    const tip = screen.getByRole('tooltip')
    expect(tip).toHaveTextContent('Make text bold. Shortcut: ⌘B.')
    const body = document.querySelector('[data-tooltip-body]')!
    expect(body).toHaveTextContent('Bold')
    expect(body).toHaveTextContent('⌘B')
    expect(body).toHaveTextContent('Make text bold.')
    // While open the trigger is described by the open tooltip only (no double announcement).
    expect(button.getAttribute('aria-describedby')).toBe(tip.id)
    act(() => button.blur())
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('lists alternative shortcuts', () => {
    render(
      <TooltipProvider lookup={lookup} platform="other">
        <Tooltip>
          <IconButton label="Redo" data-control-id="x.redo">
            R
          </IconButton>
        </Tooltip>
      </TooltipProvider>,
    )
    const button = screen.getByRole('button', { name: 'Redo' })
    expect(document.getElementById(button.getAttribute('aria-describedby')!)).toHaveTextContent(
      'Shortcut: Ctrl+Shift+Z or Ctrl+Y.',
    )
    expect(button).toHaveAttribute('aria-keyshortcuts', 'Control+Shift+Z Control+Y')
  })

  it('Escape closes the tooltip without swallowing the key for other handlers', () => {
    const seen: boolean[] = []
    render(
      <TooltipProvider lookup={lookup} platform="other">
        <div
          onKeyDown={(e: ReactKeyboardEvent) => {
            if (e.key === 'Escape') seen.push(e.defaultPrevented)
          }}
        >
          <Tooltip>
            <IconButton label="Bold" data-control-id="x.bold">
              B
            </IconButton>
          </Tooltip>
        </div>
      </TooltipProvider>,
    )
    const button = screen.getByRole('button', { name: 'Bold' })
    tab()
    act(() => button.focus())
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
    fireEvent.keyDown(button, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).toBeNull()
    // The ancestor handler ran and did not see the event as already handled.
    expect(seen).toEqual([false])
    expect(button).toHaveFocus()
  })

  it('script focus with no key press behind it (e.g. dialog auto-focus) does not open it', () => {
    const button = renderBold()
    forgetKeys()
    act(() => button.focus())
    expect(screen.queryByRole('tooltip')).toBeNull()
    // A key press (arrow-key roving, Tab) right before focus counts as keyboard focus.
    act(() => button.blur())
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    act(() => button.focus())
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
  })

  it('inside a dialog, the first Escape closes only the tooltip; the next closes the dialog', () => {
    const onOpenChange = vi.fn()
    render(
      <TooltipProvider lookup={lookup} platform="other">
        <Dialog
          open
          onOpenChange={onOpenChange}
          title="Recover?"
          closeControlId="x.bold"
          footer={
            <Tooltip>
              <Button data-control-id="x.check">Keep</Button>
            </Tooltip>
          }
        />
      </TooltipProvider>,
    )
    const keep = screen.getByRole('button', { name: 'Keep' })
    tab()
    act(() => keep.focus())
    expect(screen.getByRole('tooltip')).toHaveTextContent('Case matters.')
    fireEvent.keyDown(keep, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).toBeNull()
    expect(onOpenChange).not.toHaveBeenCalled()
    fireEvent.keyDown(keep, { key: 'Escape' })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('the dialog close (X) button carries a tooltip under its control id', () => {
    render(
      <TooltipProvider lookup={lookup} platform="other">
        <Dialog open onOpenChange={() => {}} title="T" closeLabel="Bold" closeControlId="x.bold" />
      </TooltipProvider>,
    )
    const close = screen.getByRole('button', { name: 'Bold' })
    expect(close).toHaveAttribute('data-control-id', 'x.bold')
    expect(document.getElementById(close.getAttribute('aria-describedby')!)).toHaveTextContent('Make text bold.')
  })

  it('opens on right-click / long-press (contextmenu) for non-text controls', () => {
    const button = renderBold()
    fireEvent.contextMenu(button)
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
  })

  it('a long-press tooltip stays open after a touch pointerleave, a mouse leave closes it', () => {
    vi.useFakeTimers()
    try {
      const button = renderBold()
      const leave = (pointerType: string) => {
        const ev = createEvent.pointerOut(button)
        Object.defineProperty(ev, 'pointerType', { value: pointerType })
        fireEvent(button, ev)
      }
      fireEvent.contextMenu(button)
      expect(screen.getByRole('tooltip')).toBeInTheDocument()
      leave('touch')
      act(() => void vi.advanceTimersByTime(200))
      expect(screen.getByRole('tooltip')).toBeInTheDocument()
      leave('mouse')
      act(() => void vi.advanceTimersByTime(200))
      expect(screen.queryByRole('tooltip')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('only one tooltip is open at a time', () => {
    render(
      <TooltipProvider lookup={lookup} platform="other">
        <Tooltip>
          <IconButton label="Bold" data-control-id="x.bold">
            B
          </IconButton>
        </Tooltip>
        <Tooltip>
          <IconButton label="Redo" data-control-id="x.redo">
            R
          </IconButton>
        </Tooltip>
      </TooltipProvider>,
    )
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Bold' }))
    expect(screen.getAllByRole('tooltip')).toHaveLength(1)
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Redo' }))
    expect(screen.getAllByRole('tooltip')).toHaveLength(1)
    expect(screen.getByRole('tooltip')).toHaveTextContent('Redo it.')
  })

  it('text fields: opens when tabbed to, not when focused by script/shortcut, and hides on typing', () => {
    render(
      <TooltipProvider lookup={lookup} platform="other">
        <Tooltip>
          <TextInput aria-label="Find" data-control-id="x.field" />
        </Tooltip>
      </TooltipProvider>,
    )
    const field = screen.getByRole('textbox', { name: 'Find' })
    forgetKeys()
    act(() => field.focus())
    expect(screen.queryByRole('tooltip')).toBeNull()
    act(() => field.blur())

    tab()
    act(() => field.focus())
    expect(screen.getByRole('tooltip')).toHaveTextContent('Text to find.')
    fireEvent.keyDown(field, { key: 'a' })
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('wrap: hover area is the whole checkbox row, description stays on the input', () => {
    render(
      <TooltipProvider lookup={lookup} platform="other">
        <Tooltip wrap>
          <Checkbox label="Match case" data-control-id="x.check" checked={false} onCheckedChange={() => {}} />
        </Tooltip>
      </TooltipProvider>,
    )
    const box = screen.getByRole('checkbox', { name: 'Match case' })
    expect(document.getElementById(box.getAttribute('aria-describedby')!)).toHaveTextContent('Case matters.')
    tab()
    act(() => box.focus())
    expect(screen.getByRole('tooltip')).toHaveTextContent('Case matters.')
  })

  it('forwards asChild props and ref to the control', () => {
    const ref = { current: null as HTMLElement | null }
    render(
      <TooltipProvider lookup={lookup}>
        <Tooltip ref={ref} data-extra="1" tabIndex={-1}>
          <IconButton label="Bold" data-control-id="x.bold">
            B
          </IconButton>
        </Tooltip>
      </TooltipProvider>,
    )
    const button = screen.getByRole('button', { name: 'Bold' })
    expect(ref.current).toBe(button)
    expect(button).toHaveAttribute('data-extra', '1')
    expect(button).toHaveAttribute('tabindex', '-1')
  })

  it('renders the bare control (and warns in dev) when no copy is registered', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    render(
      <TooltipProvider lookup={lookup}>
        <Tooltip>
          <IconButton label="Mystery" data-control-id="x.unknown">
            ?
          </IconButton>
        </Tooltip>
      </TooltipProvider>,
    )
    expect(screen.getByRole('button', { name: 'Mystery' })).not.toHaveAttribute('aria-describedby')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('x.unknown'))
    // Once per id, however often it renders.
    render(
      <TooltipProvider lookup={lookup}>
        <Tooltip>
          <IconButton label="Mystery again" data-control-id="x.unknown">
            ?
          </IconButton>
        </Tooltip>
      </TooltipProvider>,
    )
    expect(warn.mock.calls.filter(([m]) => String(m).includes('x.unknown'))).toHaveLength(1)
    warn.mockRestore()
  })
})
