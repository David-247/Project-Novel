import { clearMocks, mockIPC } from '@tauri-apps/api/mocks'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  FontFamilyPicker,
  fontFamilyCss,
  getEditor,
  listSystemFonts,
  NovelEditor,
  primaryFontFamily,
  SYSTEM_FONT_STACK,
} from './index'
import { installLayoutPolyfills } from './jsdom-polyfills.test-util'

beforeAll(installLayoutPolyfills)
afterEach(() => {
  cleanup()
  clearMocks()
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
})

describe('font helpers', () => {
  it('round-trips family names through CSS values', () => {
    expect(fontFamilyCss('Times New Roman')).toBe(`"Times New Roman", ${SYSTEM_FONT_STACK}`)
    for (const f of ['Times New Roman', 'Odd "Quoted" Font', 'Georgia']) {
      expect(primaryFontFamily(fontFamilyCss(f))).toBe(f)
    }
    expect(primaryFontFamily('Georgia, serif')).toBe('Georgia')
    expect(primaryFontFamily(undefined)).toBe('')
  })

  it('listSystemFonts falls back to [] outside Tauri', async () => {
    expect('__TAURI_INTERNALS__' in window).toBe(false)
    await expect(listSystemFonts()).resolves.toEqual([])
  })

  it('listSystemFonts invokes the Rust command inside Tauri', async () => {
    mockIPC((cmd) => (cmd === 'list_system_fonts' ? ['Arial', 'Georgia'] : null))
    await expect(listSystemFonts()).resolves.toEqual(['Arial', 'Georgia'])
  })

  it('listSystemFonts falls back to [] when the command fails', async () => {
    mockIPC(() => {
      throw new Error('boom')
    })
    await expect(listSystemFonts()).resolves.toEqual([])
  })
})

const fakeFonts = async () => ['Arial', 'Georgia']

describe('FontFamilyPicker', () => {
  it('offers only System default when OS fonts are unavailable', async () => {
    render(
      <>
        <FontFamilyPicker />
        <NovelEditor />
      </>,
    )
    const select = screen.getByRole('combobox', { name: 'Font' })
    await waitFor(() => expect(select).toBeEnabled())
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['System default'])
    expect(select).toHaveAttribute('title')
  })

  it('applies a selected installed font to the selection and can reset it', async () => {
    render(
      <>
        <FontFamilyPicker loadFonts={fakeFonts} />
        <NovelEditor />
      </>,
    )
    const select = screen.getByRole('combobox', { name: 'Font' })
    await screen.findByRole('option', { name: 'Georgia' })
    const ed = getEditor()!
    act(() => {
      ed.chain().insertContent('Some prose').selectAll().run()
    })

    act(() => {
      fireEvent.change(select, { target: { value: 'Georgia' } })
    })
    const mark = ed.getJSON().content![0].content![0].marks![0]
    expect(mark).toEqual({ type: 'textStyle', attrs: { fontFamily: fontFamilyCss('Georgia') } })
    await waitFor(() => expect(select).toHaveValue('Georgia'))

    act(() => {
      fireEvent.change(select, { target: { value: '' } })
    })
    expect(ed.getJSON().content![0].content![0].marks).toBeUndefined()
  })
})
