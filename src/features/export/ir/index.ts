// Public interface of the export slice's manuscript IR (docs/manuscript-ir.md). The slice index
// (src/features/export/index.ts) re-exports this file; other slices import from `@/features/export`.
//
// - buildManuscript(doc, styles, options) -> ManuscriptIR: the document (ProseMirror node or JSON)
//   with pending tracked changes accepted, cut into front matter and chapters, each block with its role,
//   runs, breaks and footnotes; `report` counts what was resolved or dropped (for the wizard's checks).
// - ManuscriptRenderer<TSettings>: what the DOCX and PDF generators implement:
//   render(ir, settings, { signal, onProgress }) -> Promise<Uint8Array>.
// - Fixtures for the renderers' and the wizard's tests: FEATURE_FIXTURE_DOC (+ styles, footnote
//   options), FIXTURE_MANUSCRIPT_IR (its IR) and createMockRenderer().
export { buildManuscript } from './build'
export type { BuildManuscriptOptions } from './build'
export { MANUSCRIPT_IR_VERSION, EMPHASIS_KEYS } from './types'
export type {
  Emphasis,
  TextRun,
  LineBreakRun,
  FootnoteRefRun,
  InlineRun,
  NoteRun,
  ParagraphRole,
  ParagraphVariant,
  ListInfo,
  ParagraphBlock,
  SceneBreakBlock,
  PageBreakBlock,
  SectionBreakBlock,
  ManuscriptBlock,
  ManuscriptChapter,
  ManuscriptFootnote,
  ManualSceneBreak,
  ManuscriptReport,
  ManuscriptIR,
} from './types'
export { assertManuscriptVersion, abortError, isAbortError, throwIfAborted, UnsupportedManuscriptVersionError } from './renderer'
export type { ManuscriptRenderer, RenderOptions, RenderProgress, ExportFormat } from './renderer'
export { manuscriptPlainText, runsText } from './plain-text'
export { manuscriptWordCount } from './word-count'
export type { ManuscriptWordCount } from './word-count'
export type { PlainTextOptions } from './plain-text'
export { createMockRenderer } from './mock-renderer'
export type { MockRenderer, MockRendererOptions } from './mock-renderer'
export { FEATURE_FIXTURE_DOC, FEATURE_FIXTURE_STYLES, FEATURE_FIXTURE_FOOTNOTES, FIXTURE_MANUSCRIPT_IR } from './fixtures'
