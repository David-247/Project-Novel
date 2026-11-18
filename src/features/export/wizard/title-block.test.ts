import { describe, expect, it } from 'vitest'
import { FIXTURE_MANUSCRIPT_IR, runsText, type ManuscriptBlock, type ManuscriptIR } from '../ir'
import { withoutTitleBlock } from './title-block'

const p = (text: string): ManuscriptBlock => ({ kind: 'paragraph', role: 'aligned', styleId: 'body', align: 'center', runs: [{ kind: 'text', text }] })
const withFront = (frontMatter: ManuscriptBlock[]): ManuscriptIR => ({ ...structuredClone(FIXTURE_MANUSCRIPT_IR), frontMatter })
const texts = (ir: ManuscriptIR) => ir.frontMatter.map((b) => (b.kind === 'paragraph' ? runsText(b.runs) : `<${b.kind}>`))
const opts = { title: 'The Long Night', names: ['', 'Ann Waight'] }

describe('withoutTitleBlock: the front matter title block does not print again after the title page', () => {
  it('the feature fixture: THE LONG NIGHT / A novel / (recto) go; the dedication starts the text', () => {
    const before = structuredClone(FIXTURE_MANUSCRIPT_IR)
    const out = withoutTitleBlock(FIXTURE_MANUSCRIPT_IR, opts)
    expect(texts(out)).toEqual(['For M.', 'Not all who wander are lost.'])
    expect(out.chapters).toBe(FIXTURE_MANUSCRIPT_IR.chapters)
    expect(FIXTURE_MANUSCRIPT_IR).toEqual(before)
  })

  it('title, subtitle and by-line in either order, punctuation and case ignored', () => {
    const front = [p('The Long Night.'), p('by Ann Waight'), p('A Novel'), { kind: 'pageBreak' } as ManuscriptBlock, p('For M.')]
    expect(texts(withoutTitleBlock(withFront(front), opts))).toEqual(['For M.'])
    expect(texts(withoutTitleBlock(withFront([p('THE LONG NIGHT'), p('A Novel by Ann Waight'), p('Prologue text.')]), opts))).toEqual(['Prologue text.'])
    expect(texts(withoutTitleBlock(withFront([p('The Long Night'), p('Ann Waight'), p('For M.')]), opts))).toEqual(['For M.'])
  })

  it('without a name on file, a short "by ..." line counts', () => {
    const ir = withFront([p('The Long Night'), p('by A. N. Other'), p('For M.')])
    expect(texts(withoutTitleBlock(ir, { title: 'The Long Night', names: [] }))).toEqual(['For M.'])
  })

  it('keeps everything when the first paragraph is not the title', () => {
    const ir = withFront([p('For M.'), p('THE LONG NIGHT'), p('A novel')])
    expect(withoutTitleBlock(ir, opts)).toBe(ir)
    expect(withoutTitleBlock(FIXTURE_MANUSCRIPT_IR, { ...opts, title: 'Another Book' })).toBe(FIXTURE_MANUSCRIPT_IR)
    expect(withoutTitleBlock(FIXTURE_MANUSCRIPT_IR, { ...opts, title: '  ' })).toBe(FIXTURE_MANUSCRIPT_IR)
  })

  it('stops at the first line that is not the title block (a different name, a sentence, a second subtitle)', () => {
    expect(texts(withoutTitleBlock(withFront([p('The Long Night'), p('by Someone Else'), p('x')]), opts))).toEqual(['by Someone Else', 'x'])
    expect(texts(withoutTitleBlock(withFront([p('The Long Night'), p('A novel'), p('A novel'), p('x')]), opts))).toEqual(['A novel', 'x'])
    const sentence = withFront([p('The Long Night'), p('By morning, the rain had stopped.')])
    expect(texts(withoutTitleBlock(sentence, { title: 'The Long Night', names: [] }))).toEqual(['By morning, the rain had stopped.'])
  })
})
