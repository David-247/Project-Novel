import type { RenderProgress } from '../ir/renderer'
import type { ManuscriptIR } from '../ir/types'
import type { DocxRenderSettings } from './types'

/** Messages between the DOCX renderer and its worker (./worker.ts). */
export type DocxWorkerRequest = { type: 'render'; ir: ManuscriptIR; settings: DocxRenderSettings }

export type DocxWorkerResponse =
  | { type: 'progress'; progress: RenderProgress }
  | { type: 'done'; bytes: Uint8Array }
  | { type: 'error'; name: string; message: string }
