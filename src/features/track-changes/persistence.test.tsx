import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { defaultBookSettings } from '@/shared/book'
import { useStore } from '@/shared/store'
import { getDocJSON, getEditor, NovelEditor, setDocJSON, type JSONContent } from '@/features/editor'
import { parseBook, serializeBook } from '@/features/storage'
import { isTracking, toggleTrackChanges } from './commands'

const normalizeBook = (data: unknown) => parseBook(JSON.stringify(data))

/** Track changes persistence: book.json `trackChanges`, and marks / block attrs in manuscript.json. */

beforeAll(() => {
  const emptyRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList
  Range.prototype.getClientRects ??= emptyRects
  Range.prototype.getBoundingClientRect ??= () => ({ top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
  Element.prototype.getClientRects ??= emptyRects
  document.elementFromPoint ??= () => null
})
afterEach(() => {
  cleanup()
  act(() => useStore.getState().bookActions.resetBook())
  setDocJSON({ type: 'doc', content: [{ type: 'paragraph' }] })
})

describe('book.json trackChanges', () => {
  it('is written only while on, read back, and toggled by the command', () => {
    expect(JSON.parse(serializeBook(defaultBookSettings()))).not.toHaveProperty('trackChanges')
    const on = { ...defaultBookSettings(), trackChanges: true }
    expect(JSON.parse(serializeBook(on)).trackChanges).toBe(true)
    expect(parseBook(serializeBook(on)).settings.trackChanges).toBe(true)
    expect(isTracking()).toBe(false)
    act(() => void toggleTrackChanges())
    expect(isTracking()).toBe(true)
    expect(useStore.getState().book.dirty).toBe(true)
  })

  it('an old book.json (no key) opens unchanged; a damaged value warns and stays off', () => {
    expect(normalizeBook({}).settings).toEqual(defaultBookSettings())
    const bad = normalizeBook({ trackChanges: 'yes' })
    expect(bad.settings.trackChanges).toBeUndefined()
    expect(bad.warnings).toEqual(['the Track Changes setting'])
    expect(normalizeBook({ trackChanges: false }).settings).toEqual(defaultBookSettings())
  })
})

describe('manuscript.json', () => {
  const stamp = { id: 'c1', author: 'Ann', date: '2026-01-01T00:00:00.000Z' }
  const doc: JSONContent = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Kept ' },
          { type: 'text', text: 'gone', marks: [{ type: 'deletion', attrs: { ...stamp, authorColor: null } }] },
          { type: 'text', text: 'new', marks: [{ type: 'insertion', attrs: { ...stamp, id: 'c2', authorColor: '#aa3300' } }] },
        ],
      },
      { type: 'paragraph', attrs: { trackedInsert: stamp }, content: [{ type: 'text', text: 'Added.' }] },
      { type: 'pageBreak', attrs: { trackedDelete: stamp } },
      { type: 'paragraph', content: [{ type: 'text', text: 'End.' }] },
    ],
  }

  it('marks and block attributes round-trip; null tracking attributes stay out of the file', () => {
    render(<NovelEditor />)
    setDocJSON(doc)
    expect(getDocJSON()).toEqual(doc)
    const p = getEditor()!.view.dom.querySelector('[data-tc-ins]') as HTMLElement
    expect(p.getAttribute('style')).toContain('#aa3300')
  })

  it('Phase 1 and Phase 2 manuscripts load and save unchanged', () => {
    const old: JSONContent = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'One' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Text', marks: [{ type: 'bold' }] }, { type: 'footnote', content: [{ type: 'text', text: 'n' }] }] },
        { type: 'sceneBreak', attrs: { ornament: '#' } },
      ],
    }
    render(<NovelEditor />)
    setDocJSON(old)
    expect(getDocJSON()).toEqual(old)
  })
})
