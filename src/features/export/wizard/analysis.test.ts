import { getSchema } from '@tiptap/core'
import { describe, expect, it } from 'vitest'
import { countManuscript, createEditorExtensions } from '@/features/editor'
import { buildManuscript, FEATURE_FIXTURE_DOC, FEATURE_FIXTURE_FOOTNOTES, FEATURE_FIXTURE_STYLES, FIXTURE_MANUSCRIPT_IR, type ManuscriptIR } from '../ir'
import { chapterIssues, chapterNumberOf, countDoubleSpaces, manuscriptWordCount, normalizeSentenceSpaces } from './analysis'
import { WIZARD_FIXTURE_DOC } from './fixtures'

const schema = getSchema(createEditorExtensions())
const build = (doc = WIZARD_FIXTURE_DOC) => buildManuscript(doc, FEATURE_FIXTURE_STYLES, { footnotes: FEATURE_FIXTURE_FOOTNOTES })

describe('manuscriptWordCount', () => {
  it('equals the live count (countManuscript) on the feature fixture and the wizard fixture', () => {
    for (const doc of [FEATURE_FIXTURE_DOC, WIZARD_FIXTURE_DOC]) {
      const live = countManuscript(schema.nodeFromJSON(doc))
      const wc = manuscriptWordCount(build(doc))
      expect(wc.body).toBe(live.body.words)
      expect(wc.footnotes).toBe(live.footnotes.words)
      expect(wc.total).toBe(live.body.words + live.footnotes.words)
    }
  })
})

describe('chapterNumberOf', () => {
  it.each([
    ['Chapter 3', 3],
    ['Chapter Three', 3],
    ['CHAPTER TWENTY-ONE', 21],
    ['Chapter twenty one: The Fall', 21],
    ['Chapter XII', 12],
    ['Ch. 4', 4],
    ['12', 12],
    ['IV.', 4],
    ['xl', 40],
  ])('%s -> %d', (text, n) => expect(chapterNumberOf(text)).toBe(n))
  it.each(['Prologue', 'The Storm', 'I Remember', '', 'Chapter', 'IIII', 'Epilogue'])('%s -> null', (text) => expect(chapterNumberOf(text)).toBeNull())
})

describe('chapterIssues', () => {
  it('on the feature fixture: the untitled chapter 3 and the empty Epilogue', () => {
    const issues = chapterIssues(FIXTURE_MANUSCRIPT_IR)
    expect(issues).toEqual([
      { kind: 'untitled', chapter: 2, label: 'Untitled chapter 3' },
      { kind: 'empty', chapter: 3, label: 'Epilogue' },
    ])
  })
  it('on the wizard fixture: also the gap from One to Three', () => {
    const issues = chapterIssues(build())
    expect(issues.map((i) => i.kind)).toEqual(['untitled', 'empty', 'gap'])
    expect(issues[2]).toMatchObject({ chapter: 3, label: 'Chapter Three · Epilogue', expected: 2, found: 3 })
  })
  it('a repeated number and a number in the title (no number line)', () => {
    const ch = (index: number, numberText: string, titleText: string) => ({ index, number: [], numberText, title: [], titleText, titleStyleId: 'chapter-title', blocks: [{ kind: 'paragraph' as const, role: 'body' as const, runs: [{ kind: 'text' as const, text: 'x' }] }] })
    const issues = chapterIssues({ chapters: [ch(0, '', 'Prologue'), ch(1, '', 'Chapter 1'), ch(2, 'Chapter 2', 'Rain'), ch(3, 'Chapter 2', 'Snow'), ch(4, '', 'Chapter 5')] })
    expect(issues.map((i) => [i.kind, i.chapter, i.expected, i.found])).toEqual([
      ['repeat', 3, 3, 2],
      ['gap', 4, 3, 5],
    ])
  })
})

describe('double spaces after a full stop', () => {
  const para = (runs: ManuscriptIR['chapters'][number]['title']): ManuscriptIR => ({
    ...FIXTURE_MANUSCRIPT_IR,
    frontMatter: [],
    footnotes: [],
    chapters: [{ index: 0, number: [], numberText: '', title: [], titleText: '', titleStyleId: 'chapter-title', blocks: [{ kind: 'paragraph', role: 'body', runs }] }],
  })
  const text = (ir: ManuscriptIR) => ir.chapters[0].blocks.map((b) => (b.kind === 'paragraph' ? b.runs.map((r) => (r.kind === 'text' ? r.text : '|')).join('') : '')).join('')

  it('counts the gaps (after . ! ? and closing quotes); one space and spaces elsewhere are fine', () => {
    expect(countDoubleSpaces(para([{ kind: 'text', text: 'One.  Two!   Three?  "Four."  Five. Six  seven.' }]))).toBe(4)
  })
  it('normalises to one space, across run boundaries too, and drops an emptied run', () => {
    const ir = para([
      { kind: 'text', text: 'He left. ', italic: true },
      { kind: 'text', text: '  ' },
      { kind: 'text', text: 'She stayed.  Then', bold: true },
      { kind: 'lineBreak' },
      { kind: 'text', text: '  indented' },
    ])
    const out = normalizeSentenceSpaces(ir)
    expect(text(out)).toBe('He left. She stayed. Then|  indented')
    expect(out.chapters[0].blocks[0].kind === 'paragraph' && out.chapters[0].blocks[0].runs.length).toBe(4)
    expect(countDoubleSpaces(out)).toBe(0)
    // The input is not changed.
    expect(text(ir)).toBe('He left.   She stayed.  Then|  indented')
  })
  it('returns the same IR when there is nothing to change', () => {
    expect(normalizeSentenceSpaces(FIXTURE_MANUSCRIPT_IR)).toBe(FIXTURE_MANUSCRIPT_IR)
  })
  it('finds the wizard fixture’s double space', () => {
    expect(countDoubleSpaces(build())).toBe(1)
    expect(countDoubleSpaces(normalizeSentenceSpaces(build()))).toBe(0)
  })
})
