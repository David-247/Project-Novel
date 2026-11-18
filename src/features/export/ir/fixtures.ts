import type { FootnoteSettings, StyleSheetJSON } from '@/shared/book'
import type { DocJSON, DocNodeJSON } from '@/shared/document'
import { MANUSCRIPT_IR_VERSION, type ManuscriptIR } from './types'

/**
 * The shared fixtures of the export slice (docs/manuscript-ir.md), for the IR's golden tests and for
 * the Wave 2 renderers and wizard:
 * - `FEATURE_FIXTURE_DOC` (+ `FEATURE_FIXTURE_STYLES`, `FEATURE_FIXTURE_FOOTNOTES`): a manuscript with
 *   every feature the IR handles: front matter, chapter numbers and titles, a style based on Chapter
 *   Title, footnotes, scene breaks (node and manual, blank-line too), tracked insertions, deletions,
 *   formatting and paragraph changes, comments, an open re-write, untitled and empty chapters, lists,
 *   block quotes, a part title, direct fonts and alignment.
 * - `FIXTURE_MANUSCRIPT_IR`: the IR `buildManuscript` gives for it (asserted by build.test.ts), so a
 *   renderer can be tested without building one.
 */

const DATE = '2026-11-01T10:00:00.000Z'
const stamp = (id: string) => ({ id, author: 'Ann', date: DATE })
type MarkJSON = NonNullable<DocNodeJSON['marks']>[number]
const ins = (id: string): MarkJSON => ({ type: 'insertion', attrs: stamp(id) })
const del = (id: string): MarkJSON => ({ type: 'deletion', attrs: stamp(id) })
const fmt = (id: string, before: unknown[] = []): MarkJSON => ({ type: 'formatChange', attrs: { ...stamp(id), before } })
const comment = (id: string): MarkJSON => ({ type: 'comment', attrs: { id } })
const bold: MarkJSON = { type: 'bold' }
const italic: MarkJSON = { type: 'italic' }
const underline: MarkJSON = { type: 'underline' }

const t = (text: string, ...marks: MarkJSON[]): DocNodeJSON => ({ type: 'text', text, ...(marks.length ? { marks } : {}) })
const p = (content: DocNodeJSON[], attrs?: Record<string, unknown>): DocNodeJSON => ({ type: 'paragraph', ...(attrs ? { attrs } : {}), ...(content.length ? { content } : {}) })
const h = (level: number, content: DocNodeJSON[], attrs: Record<string, unknown> = {}): DocNodeJSON => ({ type: 'heading', attrs: { level, ...attrs }, ...(content.length ? { content } : {}) })
const note = (...content: DocNodeJSON[]): DocNodeJSON => ({ type: 'footnote', content })
const li = (...content: DocNodeJSON[]): DocNodeJSON => ({ type: 'listItem', content })

/** A custom chapter style based on Chapter Title: it opens chapters too (chapterRoles). */
export const FEATURE_FIXTURE_STYLES: StyleSheetJSON = {
  'custom-1': { name: 'Chapter Title Alt', kind: 'chapter', outlineLevel: 1, basedOn: 'chapter-title', builtIn: false },
}

/** Book-wide arabic numbering (the default). */
export const FEATURE_FIXTURE_FOOTNOTES: FootnoteSettings = {}

export const FEATURE_FIXTURE_DOC: DocJSON = {
  type: 'doc',
  content: [
    // ---- front matter
    p([t('THE LONG NIGHT')], { textAlign: 'center' }),
    p([t('A '), t('novel', italic)], { textAlign: 'center' }),
    p([]),
    p([t('For M.')], { styleId: 'dedication' }),
    p([t('Not all who wander are lost.')], { styleId: 'epigraph' }),

    // ---- chapter 0: number + unstyled H1 title (Chapter Title by the Phase 1 mapping)
    h(1, [t('Chapter One')], { styleId: 'chapter-number' }),
    h(1, [t('The '), t('Arrival', italic)]),
    p([
      t('It was '),
      t('night', bold),
      t('.'),
      note(t('First told in '), t('1902', italic), t('.')),
      t(' '),
      t('Suddenly ', del('c-del1')),
      t('The rain fell', ins('c-ins1')),
      t(' '),
      t('hard', underline),
      t(' and ', { type: 'textStyle', attrs: { fontFamily: 'Georgia' } }),
      t('cold', italic, fmt('c-fmt1')),
      t('.', comment('k1')),
    ]),
    p([t('She waited.', { type: 'textStyle', attrs: { fontSize: '14pt' } }), { type: 'hardBreak' }, t('Nobody came.')], { lineHeight: '2' }),
    { type: 'sceneBreak', attrs: { ornament: '❦' } },
    p([t('Morning came.')]),
    p([t('* * *')]),
    p([t('Later, a letter.')]),
    p([t('Dear Ann, come home.')], {
      styleId: 'block-quote',
      trackedStyleChange: { ...stamp('c-style1'), beforeStyleId: null, beforeType: 'paragraph', beforeAttrs: {} },
    }),
    {
      type: 'bulletList',
      content: [
        li(p([t('Bread')])),
        li(p([t('Salt')]), { type: 'orderedList', attrs: { start: 3 }, content: [li(p([t('Pinch')])), li(p([t('Dash')]))] }),
      ],
    },
    p([t('She folded the list.')]),
    { type: 'pageBreak' },

    // ---- chapter 1: a custom style based on Chapter Title
    h(1, [t('The Storm')], { styleId: 'custom-1' }),
    p([t('Thunder', comment('k2')), t('.')]),
    h(2, [t('At the Harbour')]),
    p([t('Boats rocked.')]),
    p([]),
    p([t('The wind dropped.')]),
    p([t('#')]),
    p([t('A gull cried')]),
    p([t(' over the water.')], { trackedDelete: stamp('c-join') }),
    p([t('Then silence.')], { trackedInsert: stamp('c-split') }),
    p([t('Cut this line.', del('c-delpara'))], { trackedDelete: stamp('c-delpara') }),
    { type: 'pageBreak', attrs: { trackedInsert: stamp('c-pb') } },
    p([t('The tide turned.'), note(t('Second note.'))], { rewriteId: 'rw-1' }),
    p([t('They went home.')], { rewriteId: 'rw-1' }),
    p([t('— end of part one —')], { textAlign: 'right' }),
    h(1, [t('Part Two')], { styleId: 'part-title' }),
    h(1, [t('Deleted Chapter', del('c-delch'))], { styleId: 'chapter-title', trackedDelete: stamp('c-delch') }),

    // ---- chapter 2: untitled
    h(1, []),
    p([t('Nothing has a name here.')]),
    p([t('Added later.', ins('c-addp'))], { trackedInsert: stamp('c-addp') }),
    p([t('Bold now', bold, fmt('c-fmt2')), t('.')]),

    // ---- chapter 3: empty
    h(1, [t('Epilogue')]),
  ],
}

/** What `buildManuscript(FEATURE_FIXTURE_DOC, FEATURE_FIXTURE_STYLES, { footnotes: FEATURE_FIXTURE_FOOTNOTES })` gives. */
export const FIXTURE_MANUSCRIPT_IR: ManuscriptIR = {
  version: MANUSCRIPT_IR_VERSION,
  frontMatter: [
    { kind: 'paragraph', role: 'aligned', align: 'center', runs: [{ kind: 'text', text: 'THE LONG NIGHT' }] },
    { kind: 'paragraph', role: 'aligned', align: 'center', runs: [{ kind: 'text', text: 'A ' }, { kind: 'text', text: 'novel', italic: true }] },
    { kind: 'sectionBreak', start: 'recto' },
    { kind: 'paragraph', role: 'aligned', align: 'center', runs: [{ kind: 'text', text: 'For M.' }] },
    { kind: 'paragraph', role: 'blockQuote', runs: [{ kind: 'text', text: 'Not all who wander are lost.' }] },
  ],
  chapters: [
    {
      index: 0,
      number: [{ kind: 'text', text: 'Chapter One' }],
      numberText: 'Chapter One',
      title: [{ kind: 'text', text: 'The ' }, { kind: 'text', text: 'Arrival', italic: true }],
      titleText: 'The Arrival',
      titleStyleId: 'chapter-title',
      blocks: [
        {
          kind: 'paragraph',
          role: 'first',
          runs: [
            { kind: 'text', text: 'It was ' },
            { kind: 'text', text: 'night', bold: true },
            { kind: 'text', text: '.' },
            { kind: 'footnoteRef', footnote: 0 },
            { kind: 'text', text: ' The rain fell ' },
            { kind: 'text', text: 'hard', underline: true },
            { kind: 'text', text: ' and ' },
            { kind: 'text', text: 'cold', italic: true },
            { kind: 'text', text: '.' },
          ],
        },
        { kind: 'paragraph', role: 'body', runs: [{ kind: 'text', text: 'She waited.' }, { kind: 'lineBreak' }, { kind: 'text', text: 'Nobody came.' }] },
        { kind: 'sceneBreak', source: 'node', original: '❦' },
        { kind: 'paragraph', role: 'first', runs: [{ kind: 'text', text: 'Morning came.' }] },
        { kind: 'sceneBreak', source: 'manual', original: '* * *' },
        { kind: 'paragraph', role: 'first', runs: [{ kind: 'text', text: 'Later, a letter.' }] },
        { kind: 'paragraph', role: 'blockQuote', runs: [{ kind: 'text', text: 'Dear Ann, come home.' }] },
        { kind: 'paragraph', role: 'listItem', list: { marker: '•', depth: 0, ordered: false }, runs: [{ kind: 'text', text: 'Bread' }] },
        { kind: 'paragraph', role: 'listItem', list: { marker: '•', depth: 0, ordered: false }, runs: [{ kind: 'text', text: 'Salt' }] },
        { kind: 'paragraph', role: 'listItem', list: { marker: '3.', depth: 1, ordered: true }, runs: [{ kind: 'text', text: 'Pinch' }] },
        { kind: 'paragraph', role: 'listItem', list: { marker: '4.', depth: 1, ordered: true }, runs: [{ kind: 'text', text: 'Dash' }] },
        { kind: 'paragraph', role: 'body', runs: [{ kind: 'text', text: 'She folded the list.' }] },
      ],
    },
    {
      index: 1,
      number: [],
      numberText: '',
      title: [{ kind: 'text', text: 'The Storm' }],
      titleText: 'The Storm',
      titleStyleId: 'custom-1',
      blocks: [
        { kind: 'paragraph', role: 'first', runs: [{ kind: 'text', text: 'Thunder.' }] },
        { kind: 'paragraph', role: 'subheading', runs: [{ kind: 'text', text: 'At the Harbour' }] },
        { kind: 'paragraph', role: 'first', runs: [{ kind: 'text', text: 'Boats rocked.' }] },
        { kind: 'sceneBreak', source: 'manual', original: '' },
        { kind: 'paragraph', role: 'first', runs: [{ kind: 'text', text: 'The wind dropped.' }] },
        { kind: 'sceneBreak', source: 'manual', original: '#' },
        { kind: 'paragraph', role: 'first', runs: [{ kind: 'text', text: 'A gull cried over the water.' }] },
        { kind: 'paragraph', role: 'body', runs: [{ kind: 'text', text: 'Then silence.' }] },
        { kind: 'pageBreak' },
        { kind: 'paragraph', role: 'body', runs: [{ kind: 'text', text: 'The tide turned.' }, { kind: 'footnoteRef', footnote: 1 }] },
        { kind: 'paragraph', role: 'body', runs: [{ kind: 'text', text: 'They went home.' }] },
        { kind: 'paragraph', role: 'aligned', align: 'right', runs: [{ kind: 'text', text: '— end of part one —' }] },
        { kind: 'sectionBreak', start: 'recto' },
        { kind: 'paragraph', role: 'partTitle', runs: [{ kind: 'text', text: 'Part Two' }] },
      ],
    },
    {
      index: 2,
      number: [],
      numberText: '',
      title: [],
      titleText: '',
      titleStyleId: 'chapter-title',
      blocks: [
        { kind: 'paragraph', role: 'first', runs: [{ kind: 'text', text: 'Nothing has a name here.' }] },
        { kind: 'paragraph', role: 'body', runs: [{ kind: 'text', text: 'Added later.' }] },
        { kind: 'paragraph', role: 'body', runs: [{ kind: 'text', text: 'Bold now', bold: true }, { kind: 'text', text: '.' }] },
      ],
    },
    { index: 3, number: [], numberText: '', title: [{ kind: 'text', text: 'Epilogue' }], titleText: 'Epilogue', titleStyleId: 'chapter-title', blocks: [] },
  ],
  footnotes: [
    { index: 0, number: 1, label: '1', chapter: 0, runs: [{ kind: 'text', text: 'First told in ' }, { kind: 'text', text: '1902', italic: true }, { kind: 'text', text: '.' }] },
    { index: 1, number: 2, label: '2', chapter: 1, runs: [{ kind: 'text', text: 'Second note.' }] },
  ],
  report: {
    trackedChanges: { total: 11, insertions: 2, deletions: 3, formatChanges: 2, blockChanges: 7 },
    comments: 2,
    openRewrites: 1,
    manualSceneBreaks: [
      { chapter: 0, kind: 'symbol', original: '* * *' },
      { chapter: 1, kind: 'blank', original: '' },
      { chapter: 1, kind: 'symbol', original: '#' },
    ],
    strippedFormatting: { fontFamily: 1, fontSize: 1, blockLayout: 1 },
    emptyParagraphs: 1,
    redundantPageBreaks: 1,
  },
}
