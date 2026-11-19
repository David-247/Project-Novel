/// <reference lib="webworker" />
/**
 * The DOCX export worker: builds and zips the document off the main thread, so the UI stays
 * responsive during a 100k-word export. Protocol (./renderer.ts):
 * - in: `{ type: 'render', ir, settings }` (plain JSON);
 * - out: `{ type: 'progress', progress }`, then `{ type: 'done', bytes }` (transferred) or
 *   `{ type: 'error', name, message }`.
 * Cancelling terminates the worker, so it checks no signal itself.
 */
import { renderDocx } from './build'
import type { DocxWorkerRequest, DocxWorkerResponse } from './protocol'

const scope = self as unknown as DedicatedWorkerGlobalScope
const post = (msg: DocxWorkerResponse, transfer: Transferable[] = []) => scope.postMessage(msg, transfer)

scope.onmessage = async (e: MessageEvent<DocxWorkerRequest>) => {
  const msg = e.data
  if (msg?.type !== 'render') return
  try {
    const bytes = await renderDocx(msg.ir, msg.settings, { onProgress: (progress) => post({ type: 'progress', progress }) })
    post({ type: 'done', bytes }, [bytes.buffer])
  } catch (err) {
    const e2 = err as { name?: unknown; message?: unknown }
    post({ type: 'error', name: typeof e2?.name === 'string' ? e2.name : 'Error', message: typeof e2?.message === 'string' ? e2.message : String(err) })
  }
}
