import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import {
  Button,
  Checkbox,
  Dialog,
  IconButton,
  Select,
  StatusText,
  TextInput,
  ToggleButton,
  ToolbarGroup,
  ToolbarSeparator,
} from './index'

describe('shared/ui primitives', () => {
  it('Button defaults to type=button and applies the variant', () => {
    render(<Button variant="primary">Save</Button>)
    const b = screen.getByRole('button', { name: 'Save' })
    expect(b).toHaveAttribute('type', 'button')
    expect(b.className).toContain('bg-accent')
    expect(b.className).toContain('min-h-control')
  })

  it('IconButton takes its accessible name from label', () => {
    render(
      <IconButton label="Undo">
        <svg />
      </IconButton>,
    )
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument()
  })

  it('ToggleButton exposes aria-pressed and toggles', () => {
    function T() {
      const [on, setOn] = useState(false)
      return (
        <ToggleButton label="Bold" pressed={on} onPressedChange={setOn}>
          B
        </ToggleButton>
      )
    }
    render(<T />)
    const b = screen.getByRole('button', { name: 'Bold' })
    expect(b).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(b)
    expect(b).toHaveAttribute('aria-pressed', 'true')
  })

  it('ToolbarGroup and separator expose roles', () => {
    render(
      <ToolbarGroup label="Formatting">
        <ToolbarSeparator />
      </ToolbarGroup>,
    )
    expect(screen.getByRole('group', { name: 'Formatting' })).toBeInTheDocument()
    expect(screen.getByRole('separator')).toHaveAttribute('aria-orientation', 'vertical')
  })

  it('TextInput, Select and Checkbox are labelled native controls', () => {
    const onChecked = vi.fn()
    render(
      <>
        <TextInput aria-label="Find" />
        <Select aria-label="Scope" className="w-40" wrapperClassName="ml-2" options={[{ value: 'doc', label: 'Document' }]} />
        <Checkbox label="Match case" checked={false} onCheckedChange={onChecked} />
      </>,
    )
    expect(screen.getByRole('textbox', { name: 'Find' })).toBeInTheDocument()
    const select = screen.getByRole('combobox', { name: 'Scope' })
    expect(select).toHaveValue('doc')
    expect(select).toHaveClass('w-40')
    expect(select.parentElement).toHaveClass('ml-2')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Match case' }))
    expect(onChecked).toHaveBeenCalledWith(true)
  })

  it('StatusText can be a polite live region', () => {
    render(<StatusText live>Saved</StatusText>)
    expect(screen.getByText('Saved')).toHaveAttribute('aria-live', 'polite')
  })

  it('Dialog renders title, description, body and footer, and closes', () => {
    const onOpenChange = vi.fn()
    render(
      <Dialog open onOpenChange={onOpenChange} title="Rename chapter" description="Shown in the outline." footer={<Button>OK</Button>}>
        <p>body</p>
      </Dialog>,
    )
    const dlg = screen.getByRole('dialog', { name: 'Rename chapter' })
    expect(dlg).toHaveAccessibleDescription('Shown in the outline.')
    expect(screen.getByText('body')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
