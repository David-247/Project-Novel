import { getSchema } from '@tiptap/core'
import { afterEach, describe, expect, it } from 'vitest'
import { createEditorExtensions, getChapters } from '@/features/editor'
import { acceptAll } from '@/features/track-changes'
import { resolveStyleSheet } from '@/shared/book'
import type { DocJSON, DocNodeJSON } from '@/shared/document'
import { useStore } from '@/shared/store'
import { EditorState } from '@tiptap/pm/state'
import { buildManuscript } from './build'
import { FEATURE_FIXTURE_DOC, FEATURE_FIXTURE_FOOTNOTES, FEATURE_FIXTURE_STYLES, FIXTURE_MANUSCRIPT_IR } from './fixtures'
import { manuscriptPlainText } from './plain-text'
import type { ManuscriptBlock, ManuscriptIR } from './types'

const schema = getSchema(createEditorExtensions())
const build = (doc: DocJSON = FEATURE_FIXTURE_DOC, opts: Parameters<typeof buildManuscript>[2] = { footnotes: FEATURE_FIXTURE_FOOTNOTES }) =>
  buildManuscript(doc, FEATURE_FIXTURE_STYLES, opts)

const t = (text: string): DocNodeJSON => ({ type: 'text', text })
const p = (text?: string, attrs?: Record<string, unknown>): DocNodeJSON => ({ type: 'paragraph', ...(attrs ? { attrs } : {}), ...(text ? { content: [t(text)] } : {}) })
const h1 = (text: string): DocNodeJSON => ({ type: 'heading', attrs: { level: 1 }, content: [t(text)] })
const doc = (...content: DocNodeJSON[]): DocJSON => ({ type: 'doc', content })
const kinds = (blocks: readonly ManuscriptBlock[]) => blocks.map((b) => (b.kind === 'paragraph' ? `${b.role}:${b.runs.map((r) => (r.kind === 'text' ? r.text : `[${r.kind}]`)).join('')}` : b.kind === 'sceneBreak' ? `scene(${b.source}:${b.original})` : b.kind))

afterEach(() => useStore.getState().trackChangesActions.setMarkupView('all'))

describe('buildManuscript: the feature fixture (golden)', () => {
  it('gives the fixture IR: structure, roles, runs, footnotes, accepted text and the report', () => {
    expect(build()).toEqual(FIXTURE_MANUSCRIPT_IR)
  })

  it('takes a ProseMirror node or its JSON, and a resolved or a stored style sheet, alike', () => {
    const node = schema.nodeFromJSON(FEATURE_FIXTURE_DOC)
    expect(buildManuscript(node, resolveStyleSheet(FEATURE_FIXTURE_STYLES), { footnotes: FEATURE_FIXTURE_FOOTNOTES })).toEqual(FIXTURE_MANUSCRIPT_IR)
  })

  it('is plain JSON (it can cross a worker boundary) and leaves its input unchanged', () => {
    const input = structuredClone(FEATURE_FIXTURE_DOC)
    const ir = build(input)
    expect(JSON.parse(JSON.stringify(ir))).toEqual(ir)
    expect(input).toEqual(FEATURE_FIXTURE_DOC)
  })

  it('does not follow the markup view on screen: the export is always the accepted text', () => {
    useStore.getState().trackChangesActions.setMarkupView('original')
    expect(build()).toEqual(FIXTURE_MANUSCRIPT_IR)
  })

  it('exports exactly the text Accept All leaves (No Markup), without notes run into the sentence', () => {
    const text = manuscriptPlainText(build())
    expect(text).not.toMatch(/Suddenly|Cut this line|Deleted Chapter/)
    expect(text).toContain('It was night. The rain fell hard and cold.')
    expect(text).toContain('A gull cried over the water.')
    expect(text).toContain('Added later.')
    const accepted = acceptAll(EditorState.create({ schema, doc: schema.nodeFromJSON(FEATURE_FIXTURE_DOC) }))!.doc
    const styles = resolveStyleSheet(FEATURE_FIXTURE_STYLES)
    expect(build().chapters.map((c) => c.titleText)).toEqual(getChapters(accepted, styles, 'all').map((c) => c.title))
  })
})

describe('buildManuscript: rules', () => {
  it('numbers footnotes per chapter, with symbols, when the book says so', () => {
    const ir = build(FEATURE_FIXTURE_DOC, { footnotes: { numbering: 'chapter', format: 'symbols' } })
    expect(ir.footnotes.map((f) => [f.number, f.label, f.chapter])).toEqual([
      [1, '*', 0],
      [1, '*', 1],
    ])
  })

  it('counts only the open re-writes it is told about', () => {
    expect(build(FEATURE_FIXTURE_DOC, { openRewriteAnchors: [] }).report.openRewrites).toBe(0)
    expect(build(FEATURE_FIXTURE_DOC, { openRewriteAnchors: ['rw-1', 'rw-9'] }).report.openRewrites).toBe(1)
  })

  it('puts a document without chapter titles in the front matter', () => {
    const ir = build(doc(p('One.'), p('Two.')))
    expect(ir.chapters).toEqual([])
    expect(kinds(ir.frontMatter)).toEqual(['first:One.', 'body:Two.'])
  })

  it('reads one blank-line break from consecutive empty paragraphs, and drops empty ones at edges and after headings', () => {
    const ir = build(doc(h1('A'), p(), p('One.'), p(), p(), p('Two.'), { type: 'heading', attrs: { level: 2 }, content: [t('Sub')] }, p(), p('Three.'), p()))
    expect(kinds(ir.chapters[0].blocks)).toEqual(['first:One.', 'scene(manual:)', 'first:Two.', 'subheading:Sub', 'first:Three.'])
    expect(ir.report.emptyParagraphs).toBe(4)
    expect(ir.report.manualSceneBreaks).toEqual([{ chapter: 0, kind: 'blank', original: '' }])
  })

  it('reads "***", "#", ornaments and Scene Break paragraphs as scene breaks, not text with stars in it', () => {
    const ir = build(doc(h1('A'), p('x'), p('***'), p('y'), p(' ### '), p('z'), p('⁂'), p('w'), p('~', { styleId: 'scene-break' }), p('*Not* a break'), p('3 * 4 = 12')))
    expect(kinds(ir.chapters[0].blocks)).toEqual([
      'first:x', 'scene(manual:***)', 'first:y', 'scene(manual:###)', 'first:z', 'scene(manual:⁂)', 'first:w', 'scene(manual:~)', 'first:*Not* a break', 'body:3 * 4 = 12',
    ])
  })

  it('collapses a page break before a section break, and before a chapter or the end', () => {
    const ir = build(doc(h1('A'), p('x'), { type: 'pageBreak' }, { type: 'heading', attrs: { level: 1, styleId: 'part-title' }, content: [t('Part')] }, p('y'), { type: 'pageBreak' }))
    expect(kinds(ir.chapters[0].blocks)).toEqual(['first:x', 'sectionBreak', 'partTitle:Part', 'first:y'])
    expect(ir.report.redundantPageBreaks).toBe(2)
  })

  it('keeps an inserted footnote and drops a deleted one (numbers follow the accepted text)', () => {
    const d = { id: 'd', author: 'Ann', date: '2026-01-01T00:00:00.000Z' }
    const ir = build(
      doc(
        h1('A'),
        {
          type: 'paragraph',
          content: [t('x'), { type: 'footnote', marks: [{ type: 'deletion', attrs: d }], content: [t('gone')] }, t('y'), { type: 'footnote', marks: [{ type: 'insertion', attrs: { ...d, id: 'i' } }], content: [t('kept')] }],
        },
      ),
    )
    expect(ir.footnotes.map((f) => [f.number, f.runs])).toEqual([[1, [{ kind: 'text', text: 'kept' }]]])
    expect(ir.chapters[0].blocks).toEqual([{ kind: 'paragraph', role: 'first', runs: [{ kind: 'text', text: 'xy' }, { kind: 'footnoteRef', footnote: 0 }] }])
  })

  it('joins two chapter number blocks before a title; a number block with no title after it is not a chapter', () => {
    const num = (text: string): DocNodeJSON => ({ type: 'heading', attrs: { level: 1, styleId: 'chapter-number' }, content: [t(text)] })
    const ir = build(doc(num('Part I'), num('Chapter 1'), h1('Begin'), p('x'), num('Stray'), p('y')))
    expect(ir.chapters.map((c) => [c.numberText, c.number, c.titleText])).toEqual([
      ['Part I\nChapter 1', [{ kind: 'text', text: 'Part I' }, { kind: 'lineBreak' }, { kind: 'text', text: 'Chapter 1' }], 'Begin'],
    ])
    expect(kinds(ir.chapters[0].blocks)).toEqual(['first:x', 'sectionBreak', 'partTitle:Stray', 'first:y'])
  })

  it('keeps emphasis in notes and titles, and drops fonts, sizes and paragraph layout (counted)', () => {
    const ir = build(
      doc(
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Big', marks: [{ type: 'textStyle', attrs: { fontSize: '30pt', fontFamily: 'Arial' } }, { type: 'bold' }] }] },
        { type: 'paragraph', attrs: { indent: 2, firstLineIndent: '1in' }, content: [t('x')] },
      ),
    )
    expect(ir.chapters[0].title).toEqual([{ kind: 'text', text: 'Big', bold: true }])
    expect(ir.report.strippedFormatting).toEqual({ fontFamily: 1, fontSize: 1, blockLayout: 1 })
  })

  it('reports nothing for a clean manuscript', () => {
    const ir: ManuscriptIR = build(doc(h1('A'), p('x')))
    expect(ir.report).toEqual({
      trackedChanges: { total: 0, insertions: 0, deletions: 0, formatChanges: 0, blockChanges: 0 },
      comments: 0,
      openRewrites: 0,
      manualSceneBreaks: [],
      strippedFormatting: { fontFamily: 0, fontSize: 0, blockLayout: 0 },
      emptyParagraphs: 0,
      redundantPageBreaks: 0,
    })
  })
})
