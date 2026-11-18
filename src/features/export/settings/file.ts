import { defaultManuscriptSettings, PRESETS } from './presets'
import type { ContactOverride, ManuscriptSettings } from './types'
import { CONTACT_FIELDS, CONTACT_MAX } from './types'

/**
 * export.json (docs/project-format.md, "export.json"): the project's manuscript export settings, a
 * project side file. Pure parse / serialize; the store and the storage hook are in store.ts and
 * persistence.ts. A reader never throws: a wrongly typed value falls back to its default, unknown keys
 * are returned in `extra` / `settingsExtra` and written back.
 */
export const EXPORT_FILE = 'export.json'
export const EXPORT_FILE_VERSION = 1

/** Largest chapter drop: half the text-area height (docs/manuscript-format.md: one third to one half). */
export const MAX_CHAPTER_DROP = 0.5

export interface ExportFileContent {
  settings: ManuscriptSettings
  /** Per-project contact override: only the fields the user set for this project. */
  contact: ContactOverride
  /** Unknown top-level keys. */
  extra: Record<string, unknown>
  /** Unknown keys inside `settings`. */
  settingsExtra?: Record<string, unknown>
}

export interface ParsedExportFile extends ExportFileContent {
  /** The file's version when it is newer than this Novel understands. */
  newer?: number
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const oneOf = <T extends string | number>(v: unknown, allowed: readonly T[]): T | undefined => (allowed.includes(v as T) ? (v as T) : undefined)
const text = (v: unknown, max: number): string | undefined => (typeof v === 'string' ? v.slice(0, max) : undefined)
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined)
const range = (v: unknown, min: number, max: number): number | undefined => (isNum(v) && v >= min && v <= max ? v : undefined)

const SETTINGS_KEYS = [
  'preset', 'paper', 'fontFamily', 'fontSizePt', 'lineSpacing', 'margins', 'firstLineIndentIn', 'indentFirstParagraph',
  'italics', 'sentenceSpacing', 'header', 'sceneBreak', 'chapterDropFraction', 'endMarker', 'titlePage',
  'wordCountRounding', 'outputs',
] as const

/** Keys an older file may carry that are dropped on read (and so on the next write), not kept as unknown. */
const DROPPED_KEYS = new Set(['lastOutputFolder'])

/** `settings` of the file over the defaults, field by field. */
export function readSettings(raw: Obj, locale: string | null | undefined): { settings: ManuscriptSettings; extra: Obj } {
  const d = defaultManuscriptSettings(locale)
  const m = isObj(raw.margins) ? raw.margins : {}
  const h = isObj(raw.header) ? raw.header : {}
  const t = isObj(raw.titlePage) ? raw.titlePage : {}
  const o = isObj(raw.outputs) ? raw.outputs : {}
  const margin = (v: unknown, fallback: number) => range(v, 0, 4) ?? fallback
  // Not trimmed: a field being typed into must keep the space just typed. Blank falls back to the default.
  const fam = text(raw.fontFamily, 80)
  const marker = text(raw.sceneBreak, 20)
  const settings: ManuscriptSettings = {
    preset: oneOf(raw.preset, Object.keys(PRESETS) as (keyof typeof PRESETS)[]) ?? d.preset,
    paper: oneOf(raw.paper, ['letter', 'a4'] as const) ?? d.paper,
    fontFamily: fam && fam.trim() ? fam : d.fontFamily,
    fontSizePt: range(raw.fontSizePt, 8, 24) ?? d.fontSizePt,
    lineSpacing: oneOf(raw.lineSpacing, [1, 1.5, 2] as const) ?? d.lineSpacing,
    margins: { top: margin(m.top, d.margins.top), right: margin(m.right, d.margins.right), bottom: margin(m.bottom, d.margins.bottom), left: margin(m.left, d.margins.left) },
    firstLineIndentIn: range(raw.firstLineIndentIn, 0, 2) ?? d.firstLineIndentIn,
    indentFirstParagraph: bool(raw.indentFirstParagraph) ?? d.indentFirstParagraph,
    italics: oneOf(raw.italics, ['italic', 'underline'] as const) ?? d.italics,
    sentenceSpacing: oneOf(raw.sentenceSpacing, [1, 2] as const) ?? d.sentenceSpacing,
    header: {
      format: oneOf(h.format, ['surname-title-page', 'title-surname-page', 'surname-page', 'page', 'none'] as const) ?? d.header.format,
      titleCase: oneOf(h.titleCase, ['as-typed', 'upper'] as const) ?? d.header.titleCase,
      startPage: oneOf(h.startPage, [1, 2] as const) ?? d.header.startPage,
      shortTitle: text(h.shortTitle, 80) ?? d.header.shortTitle,
    },
    sceneBreak: marker && marker.trim() ? marker : d.sceneBreak,
    chapterDropFraction: range(raw.chapterDropFraction, 0, MAX_CHAPTER_DROP) ?? d.chapterDropFraction,
    endMarker: oneOf(raw.endMarker, ['none', 'end', 'the-end'] as const) ?? d.endMarker,
    titlePage: {
      include: bool(t.include) ?? d.titlePage.include,
      showContact: bool(t.showContact) ?? d.titlePage.showContact,
      showAgent: bool(t.showAgent) ?? d.titlePage.showAgent,
      showWordCount: bool(t.showWordCount) ?? d.titlePage.showWordCount,
      bylineStyle: oneOf(t.bylineStyle, ['a-novel-by', 'by', 'name-only'] as const) ?? d.titlePage.bylineStyle,
    },
    wordCountRounding: oneOf(raw.wordCountRounding, ['auto', 'nearest-100', 'nearest-500', 'nearest-1000', 'exact'] as const) ?? d.wordCountRounding,
    outputs: { docx: bool(o.docx) ?? d.outputs.docx, pdf: bool(o.pdf) ?? d.outputs.pdf },
  }
  const known = new Set<string>(SETTINGS_KEYS)
  const extra: Obj = {}
  for (const [k, v] of Object.entries(raw)) if (!known.has(k) && !DROPPED_KEYS.has(k)) extra[k] = v
  return { settings, extra }
}

/** The per-project contact override: only non-empty strings, trimmed and length-limited. */
function readContact(raw: unknown): ContactOverride {
  const out: ContactOverride = {}
  if (!isObj(raw)) return out
  for (const k of CONTACT_FIELDS) {
    const v = typeof raw[k] === 'string' ? (raw[k] as string).trim().slice(0, CONTACT_MAX[k]) : ''
    if (v !== '') out[k] = v
  }
  return out
}

/**
 * Parse export.json (`null`: no file, the defaults for `locale`). Never throws.
 * Version: absent or not a number counts as 1; above EXPORT_FILE_VERSION is reported in `newer`.
 */
export function parseExportFile(data: unknown, locale?: string | null): ParsedExportFile {
  if (!isObj(data)) return { settings: defaultManuscriptSettings(locale), contact: {}, extra: {} }
  const { settings, extra: settingsExtra } = readSettings(isObj(data.settings) ? data.settings : {}, locale)
  const extra: Obj = {}
  for (const [k, v] of Object.entries(data)) if (k !== 'version' && k !== 'settings' && k !== 'contact') extra[k] = v
  const version = isNum(data.version) ? data.version : 1
  const parsed: ParsedExportFile = { settings, contact: readContact(data.contact), extra, settingsExtra }
  if (version > EXPORT_FILE_VERSION) parsed.newer = version
  return parsed
}

/**
 * The JSON of export.json. Unknown keys first (ours win a clash). `contact` is written only when the
 * project overrides something: personal details never reach a project folder otherwise.
 */
export function serializeExportFile(content: ExportFileContent): Record<string, unknown> {
  const contact = readContact(content.contact)
  const out: Record<string, unknown> = {
    ...content.extra,
    version: EXPORT_FILE_VERSION,
    settings: { ...(content.settingsExtra ?? {}), ...content.settings },
  }
  if (Object.keys(contact).length > 0) out.contact = contact
  return out
}
