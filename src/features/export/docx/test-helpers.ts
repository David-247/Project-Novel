import { strFromU8, unzipSync } from 'fflate'
import { FIXTURE_MANUSCRIPT_IR } from '../ir/fixtures'
import { manuscriptWordCount } from '../ir/word-count'
import { defaultManuscriptSettings } from '../settings/presets'
import type { ManuscriptSettings } from '../settings/types'
import type { DocxRenderSettings, ManuscriptExportInfo } from './types'

/** Test helpers for the DOCX generator (Vitest only). */

export const TEST_INFO: ManuscriptExportInfo = {
  title: 'The Long Night',
  contact: {
    legalName: 'Ann Example',
    penName: 'Perry Slaughter',
    address: '1 Main Street\nSpringfield, IL 62701',
    phone: '555-0100',
    email: 'ann@example.com',
    agent: 'Jo Agent, Example Agency',
  },
  language: 'en-US',
  // The wizard passes the count; here, the fixture's (text and footnotes).
  wordCount: manuscriptWordCount(FIXTURE_MANUSCRIPT_IR).total,
}

export function testSettings(patch: Partial<ManuscriptSettings> = {}, info: Partial<ManuscriptExportInfo> = {}): DocxRenderSettings {
  return { ...defaultManuscriptSettings('en-US'), ...patch, info: { ...TEST_INFO, ...info } }
}

/** The parts of a .docx as text, by path. */
export function unzipDocx(bytes: Uint8Array): Record<string, string> {
  const files = unzipSync(bytes)
  return Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strFromU8(v)]))
}

export function parseXml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  const err = doc.getElementsByTagName('parsererror')[0]
  if (err) throw new Error(`Not well-formed XML: ${err.textContent}`)
  return doc
}

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'

/** Elements `w:<name>` under `root`. */
export const wAll = (root: Document | Element, name: string): Element[] => Array.from(root.getElementsByTagNameNS(W, name))
export const wAttr = (el: Element | undefined | null, name: string): string | null => el?.getAttributeNS(W, name) ?? el?.getAttribute(`w:${name}`) ?? null

/** The paragraph's style id ('' for Normal). */
export const pStyle = (p: Element): string => wAttr(wAll(p, 'pStyle')[0], 'val') ?? ''

/** The paragraph's text: w:t, tabs as "\t", breaks as "\n". */
export function pText(p: Element): string {
  let out = ''
  const walk = (n: Element) => {
    for (const c of Array.from(n.children)) {
      if (c.namespaceURI !== W) continue
      if (c.localName === 't') out += c.textContent ?? ''
      else if (c.localName === 'tab' && n.localName === 'r') out += '\t'
      else if (c.localName === 'br') out += '\n'
      else if (c.localName !== 'pPr' && c.localName !== 'rPr') walk(c)
    }
  }
  walk(p)
  return out
}

/** A style element of styles.xml by id. */
export function styleById(styles: Document, id: string): Element {
  const s = wAll(styles, 'style').find((e) => wAttr(e, 'styleId') === id)
  if (!s) throw new Error(`No style ${id}`)
  return s
}
