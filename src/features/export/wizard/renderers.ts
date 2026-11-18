import { useSyncExternalStore } from 'react'
import type { ManuscriptSettings } from '../settings'
import { createMockRenderer, type ManuscriptIR, type ManuscriptRenderer, type MockRendererOptions, type RenderOptions } from '../ir'
import type { TitlePageData } from './title-page'

/**
 * The export wizard's renderers: injected, so the wizard does not depend on a generator. The
 * composition root registers the DOCX and PDF generators (`setExportRenderers`); tests and the e2e
 * build register the mock (`createMockExportRenderers`). A format with no renderer cannot be chosen.
 */

export type WizardFormat = 'docx' | 'pdf'
export const WIZARD_FORMATS: readonly WizardFormat[] = ['docx', 'pdf']

/** Everything one export needs: the IR (with the export-only options applied), the settings, the title page. */
export interface ExportJob {
  ir: ManuscriptIR
  settings: ManuscriptSettings
  titlePage: TitlePageData
}

export interface ExportRenderer {
  readonly format: WizardFormat
  render(job: ExportJob, options?: RenderOptions): Promise<Uint8Array>
}

/**
 * Wrap a `ManuscriptRenderer` (docs/manuscript-ir.md) for the wizard. `toSettings` builds what that
 * renderer takes from the job: by default the manuscript settings; a generator whose settings type also
 * carries the title page passes e.g. `(job) => ({ ...job.settings, titlePage: { ...job.settings.titlePage, ...job.titlePage } })`.
 */
export function fromManuscriptRenderer<T>(
  format: WizardFormat,
  renderer: ManuscriptRenderer<T>,
  toSettings: (job: ExportJob) => T = (job) => job.settings as unknown as T,
): ExportRenderer {
  return { format, render: (job, options) => renderer.render(job.ir, toSettings(job), options) }
}

let renderers: Partial<Record<WizardFormat, ExportRenderer>> = {}
const listeners = new Set<() => void>()
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** Register renderers (replacing those of the same format). Returns a function that removes them again. */
export function setExportRenderers(next: Partial<Record<WizardFormat, ExportRenderer>>): () => void {
  const before = renderers
  renderers = { ...renderers, ...next }
  listeners.forEach((l) => l())
  return () => {
    const kept = { ...renderers }
    for (const f of Object.keys(next) as WizardFormat[]) if (kept[f] === next[f]) kept[f] = before[f]
    renderers = kept
    listeners.forEach((l) => l())
  }
}

export const getExportRenderer = (format: WizardFormat): ExportRenderer | undefined => renderers[format]
const snapshot = () => renderers
export const useExportRenderers = (): Partial<Record<WizardFormat, ExportRenderer>> => useSyncExternalStore(subscribe, snapshot, snapshot)

/**
 * Mock DOCX and PDF renderers (the IR's mock renderer: the bytes are the manuscript's plain text), for
 * the wizard's tests and the e2e build. Not a generator: the files hold text, not DOCX or PDF.
 */
export function createMockExportRenderers(options: MockRendererOptions = {}): Record<WizardFormat, ExportRenderer> {
  return {
    docx: fromManuscriptRenderer('docx', createMockRenderer(options)),
    pdf: fromManuscriptRenderer('pdf', createMockRenderer(options)),
  }
}

/** Test-only. */
export function __resetExportRenderersForTests(): void {
  renderers = {}
  listeners.forEach((l) => l())
}
