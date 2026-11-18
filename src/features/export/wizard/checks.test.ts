import { describe, expect, it } from 'vitest'
import { buildManuscript, FEATURE_FIXTURE_FOOTNOTES, FEATURE_FIXTURE_STYLES, FIXTURE_MANUSCRIPT_IR } from '../ir'
import { defaultManuscriptSettings, type ContactDetails, type ManuscriptSettings } from '../settings'
import { manuscriptWordCount } from './analysis'
import { hasBlocking, runChecks, sortChecks, type CheckId, type CheckInput } from './checks'
import { WIZARD_FIXTURE_DOC } from './fixtures'

const CONTACT: ContactDetails = { legalName: 'Ann Waight', penName: '', address: '1 Quay St', phone: '', email: 'ann@example.com', agent: '' }
const ir = buildManuscript(WIZARD_FIXTURE_DOC, FEATURE_FIXTURE_STYLES, { footnotes: FEATURE_FIXTURE_FOOTNOTES })

function input(patch: Partial<CheckInput> = {}, settings: Partial<ManuscriptSettings> = {}): CheckInput {
  return { ir, settings: { ...defaultManuscriptSettings('en-US'), ...settings }, title: 'The Long Night', contact: CONTACT, wordCount: manuscriptWordCount(ir).total, ...patch }
}
const byId = (i: CheckInput) => Object.fromEntries(runChecks(i).map((c) => [c.id, c])) as Record<CheckId, ReturnType<typeof runChecks>[number]>

describe('runChecks on the wizard fixture', () => {
  it('every check the ticket lists fires, with its severity and action', () => {
    const c = byId(input({}, { checks: { genre: 'thriller', debut: false, normalizeSpaces: false, blankLineSceneBreaks: 'auto' } }))
    expect(c['word-count']).toMatchObject({ severity: 'warning', actions: [{ kind: 'fix', field: 'genre' }] })
    expect(c['word-count'].summary).toMatch(/shorter than the usual 80,000 to 100,000 words for Thriller/)
    expect(c['tracked-changes']).toMatchObject({ severity: 'warning', actions: [{ kind: 'review-changes' }] })
    expect(c['tracked-changes'].summary).toBe('11 tracked changes are still pending.')
    expect(c.comments).toMatchObject({ severity: 'info', actions: [{ kind: 'show-comments' }] })
    expect(c.rewrites).toMatchObject({ severity: 'warning', actions: [{ kind: 'open-rewrite' }] })
    expect(c.chapters.severity).toBe('warning')
    expect(c.chapters.actions).toEqual([
      { kind: 'show-chapter', chapter: 2, issue: 'untitled', label: 'Untitled chapter 3 has no title or number.' },
      { kind: 'show-chapter', chapter: 3, issue: 'empty', label: 'Chapter Three · Epilogue has no text.' },
      { kind: 'show-chapter', chapter: 3, issue: 'gap', label: 'Chapter Three · Epilogue: chapter 2 was expected, it is numbered 3.' },
    ])
    expect(c['scene-breaks']).toMatchObject({ severity: 'info' })
    expect(c['scene-breaks'].summary).toBe('2 typed breaks and 1 blank line will be exported as "#".')
    expect(c.formatting).toMatchObject({ severity: 'info', summary: 'Book formatting is left out: 1 font change, 1 size change, 1 paragraph layout.' })
    expect(c['double-spaces']).toMatchObject({ severity: 'info', summary: '1 place has two spaces after a full stop.' })
    // With a complete title page nothing blocks.
    expect(c.title.severity).toBe('pass')
    expect(c.name.severity).toBe('pass')
    expect(c.contact.severity).toBe('pass')
    expect(hasBlocking(runChecks(input()))).toBe(false)
  })

  it('missing title, name or contact details block the export, each with its Fix', () => {
    const empty: ContactDetails = { legalName: '', penName: '', address: '', phone: '', email: '', agent: '' }
    const c = byId(input({ title: '  ', contact: empty }))
    expect(c.title).toMatchObject({ severity: 'blocking', actions: [{ kind: 'fix', field: 'title' }] })
    expect(c.name).toMatchObject({ severity: 'blocking', actions: [{ kind: 'fix', field: 'penName' }] })
    expect(c.contact).toMatchObject({ severity: 'blocking', actions: [{ kind: 'fix', field: 'legalName' }, { kind: 'fix', field: 'email' }] })
    expect(hasBlocking(runChecks(input({ title: '' })))).toBe(true)
    // A pen name gives a by-line, but the contact block still needs the legal name.
    const pen = byId(input({ contact: { ...empty, penName: 'A. W. Night', email: 'x@y.z' } }))
    expect(pen.name.severity).toBe('pass')
    expect(pen.contact).toMatchObject({ severity: 'blocking', actions: [{ kind: 'fix', field: 'legalName' }] })
    // Without a contact block on the title page, contact details are not needed.
    const off = byId(input({ contact: { ...empty, legalName: 'Ann' } }, { titlePage: { ...defaultManuscriptSettings().titlePage, showContact: false } }))
    expect(off.contact.severity).toBe('pass')
  })

  it('word count: no genre is a note with a Choose a genre action; within the range passes; debut ranges', () => {
    expect(byId(input())['word-count']).toMatchObject({ severity: 'info', actions: [{ kind: 'fix', field: 'genre' }] })
    const checks = (genre: string, debut = false, wordCount = 90_000) => byId(input({ wordCount }, { checks: { genre, debut, normalizeSpaces: false, blankLineSceneBreaks: 'auto' } }))['word-count']
    expect(checks('thriller').severity).toBe('pass')
    expect(checks('fantasy', true).summary).toMatch(/shorter than the usual 100,000 to 120,000 words for Fantasy \(debut\)/)
    expect(checks('fantasy', false, 160_000).summary).toMatch(/much longer/)
    expect(checks('space-opera').severity).toBe('info')
  })

  it('a clean manuscript passes everything', () => {
    const clean = { ...FIXTURE_MANUSCRIPT_IR, chapters: [], report: { ...FIXTURE_MANUSCRIPT_IR.report, trackedChanges: { total: 0, insertions: 0, deletions: 0, formatChanges: 0, blockChanges: 0 }, comments: 0, openRewrites: 0, manualSceneBreaks: [], strippedFormatting: { fontFamily: 0, fontSize: 0, blockLayout: 0 } } }
    const c = byId(input({ ir: clean }, { checks: { genre: 'literary', debut: false, normalizeSpaces: false, blankLineSceneBreaks: 'auto' } }))
    for (const id of ['tracked-changes', 'comments', 'rewrites', 'scene-breaks', 'formatting', 'double-spaces'] as const) expect(c[id].severity, id).toBe('pass')
    expect(c.chapters.severity).toBe('info')
  })

  it('sortChecks puts blocking first, then warnings, notes and passes', () => {
    const sorted = sortChecks(runChecks(input({ title: '' })))
    expect(sorted[0].id).toBe('title')
    const order = sorted.map((c) => c.severity)
    expect(order).toEqual([...order].sort((a, b) => ['blocking', 'warning', 'info', 'pass'].indexOf(a) - ['blocking', 'warning', 'info', 'pass'].indexOf(b)))
  })

  it('the scene-break marker named is the trimmed setting', () => {
    expect(byId(input({}, { sceneBreak: ' * * * ' }))['scene-breaks'].summary).toMatch(/exported as "\* \* \*"/)
  })
})
