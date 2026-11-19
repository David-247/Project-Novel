import { describe, expect, it } from 'vitest'
import { FIXTURE_MANUSCRIPT_IR } from '../ir/fixtures'
import { renderDocx } from './build'
import { testSettings, unzipDocx } from './test-helpers'

// Golden test on the feature fixture: the main parts of the .docx, one tag per line, against the files
// in ./__golden__ (update with `pnpm vitest run -u` after checking the diff by hand, in Word).

const pretty = (xml: string) => xml.replace(/></g, '>\n<')

describe('DOCX golden output (feature fixture)', () => {
  const cases = [
    ['standard', testSettings()],
    ['classic', testSettings({ preset: 'classic', fontFamily: 'Courier New', italics: 'underline', sentenceSpacing: 2, paper: 'a4', endMarker: 'end' })],
  ] as const

  it.each(cases)('%s', async (name, settings) => {
    const files = unzipDocx(await renderDocx(FIXTURE_MANUSCRIPT_IR, settings, { now: new Date('2026-11-18T12:00:00.000Z') }))
    for (const part of ['word/document.xml', 'word/styles.xml', 'word/header1.xml', 'word/footnotes.xml', 'docProps/core.xml']) {
      await expect(pretty(files[part])).toMatchFileSnapshot(`./__golden__/${name}/${part.replace(/\//g, '_')}`)
    }
  })
})
