import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { AppShell } from './index'

describe('AppShell', () => {
  it('renders toolbar and editor slots', () => {
    render(<AppShell toolbar={<span>tb</span>} editor={<span>ed</span>} />)
    expect(screen.getByRole('banner', { name: 'Toolbar' })).toHaveTextContent('tb')
    expect(screen.getByRole('main', { name: 'Editor' })).toHaveTextContent('ed')
  })
})
