import { describe, expect, it } from 'vitest'
import { defaultManuscriptSettings, type ContactDetails } from '../settings'
import { bylineText, contactLines, fileNameOf, folderOf, headerText, manuscriptFileName, titlePageData } from './title-page'

const S = () => defaultManuscriptSettings('en-US')
const CONTACT: ContactDetails = { legalName: ' Ann Waight ', penName: '', address: '1 Quay St\nPort Town ', phone: '555 0100', email: 'ann@example.com', agent: 'Agency Ltd\nLondon' }

describe('titlePageData', () => {
  it('trims what it uses: the title, the contact fields and the short title setting', () => {
    const d = titlePageData({ ...S(), header: { ...S().header, shortTitle: '  Night ' } }, CONTACT, ' The Long Night ', 82_260)
    expect(d).toMatchObject({ title: 'The Long Night', name: 'Ann Waight', surname: 'Waight', shortTitle: 'Night', byline: 'A Novel by Ann Waight', wordCountText: 'about 82,500 words' })
    expect(d.contact.legalName).toBe('Ann Waight')
  })
  it('the pen name is the by-line and the header surname; the short title falls back to the title', () => {
    const d = titlePageData(S(), { ...CONTACT, penName: 'A. W. Night Jr.' }, 'The Long Night', 100)
    expect(d).toMatchObject({ name: 'A. W. Night Jr.', surname: 'Night', shortTitle: 'The Long Night' })
  })
  it('by-line styles', () => {
    expect(bylineText('a-novel-by', 'Ann')).toBe('A Novel by Ann')
    expect(bylineText('by', 'Ann')).toBe('by Ann')
    expect(bylineText('name-only', 'Ann')).toBe('Ann')
    expect(bylineText('by', '')).toBe('')
  })
})

describe('headerText', () => {
  const data = { surname: 'Waight', shortTitle: 'The Long Night' }
  it('"Waight / The Long Night / 1" on page 2 (the first text page), none on the title page', () => {
    expect(headerText(S(), data, 1)).toBe('')
    expect(headerText(S(), data, 2)).toBe('Waight / The Long Night / 1')
    expect(headerText({ ...S(), header: { ...S().header, titleCase: 'upper' } }, data, 3)).toBe('Waight / THE LONG NIGHT / 2')
  })
  it('without a title page every page has a header, numbered from 1', () => {
    expect(headerText({ ...S(), titlePage: { ...S().titlePage, include: false } }, data, 1)).toBe('Waight / The Long Night / 1')
  })
})

describe('contactLines', () => {
  it('legal name, address lines, phone, email; the agent only when shown', () => {
    const c = titlePageData(S(), CONTACT, 'T', 0).contact
    expect(contactLines(S(), c)).toEqual(['Ann Waight', '1 Quay St', 'Port Town', '555 0100', 'ann@example.com'])
    expect(contactLines({ ...S(), titlePage: { ...S().titlePage, showAgent: true } }, c)).toEqual(['Ann Waight', '1 Quay St', 'Port Town', '555 0100', 'ann@example.com', 'Agency Ltd', 'London'])
    expect(contactLines({ ...S(), titlePage: { ...S().titlePage, showContact: false } }, c)).toEqual([])
  })
})

describe('file names and paths', () => {
  it('Surname_TITLE_manuscript.ext, safe for every OS', () => {
    expect(manuscriptFileName({ surname: 'Waight', shortTitle: 'The Long Night' }, 'docx')).toBe('Waight_THE_LONG_NIGHT_manuscript.docx')
    expect(manuscriptFileName({ surname: "O'Brien", shortTitle: 'Who? What: Why/Now' }, 'pdf')).toBe("O'Brien_WHO_WHAT_WHYNOW_manuscript.pdf")
    expect(manuscriptFileName({ surname: '', shortTitle: '' }, 'pdf')).toBe('Manuscript.pdf')
    expect(manuscriptFileName({ surname: '', shortTitle: 'Night' }, 'pdf')).toBe('NIGHT_manuscript.pdf')
  })
  it('folderOf / fileNameOf on POSIX and Windows paths', () => {
    expect(folderOf('/exports/a.pdf')).toBe('/exports')
    expect(folderOf('C:\\Books\\a.docx')).toBe('C:\\Books')
    expect(folderOf('C:\\a.docx')).toBe('C:\\')
    expect(folderOf('a.pdf')).toBeNull()
    expect(fileNameOf('C:\\Books\\a.docx')).toBe('a.docx')
    expect(fileNameOf('/x/y/b.pdf')).toBe('b.pdf')
  })
})
