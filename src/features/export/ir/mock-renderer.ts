import type { ManuscriptSettings } from '../settings'
import { manuscriptPlainText } from './plain-text'
import { assertManuscriptVersion, throwIfAborted, type ManuscriptRenderer, type RenderOptions } from './renderer'
import type { ManuscriptIR } from './types'

export interface MockRenderer<TSettings> extends ManuscriptRenderer<TSettings> {
  /** Every render call, in order (the IR and settings as passed). */
  readonly calls: { ir: ManuscriptIR; settings: TSettings }[]
}

export interface MockRendererOptions {
  /** Wait this long (ms) between chapters, so a test can cancel mid-render (default 0: a macrotask). */
  delayMs?: number
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * A renderer that keeps the contract (./renderer.ts) without a real format: the bytes are the
 * manuscript's plain text (`manuscriptPlainText`, footnotes included) in UTF-8. Progress is reported
 * per chapter; cancelling between chapters rejects with an AbortError. For the wizard's tests and
 * as the reference the DOCX / PDF renderers are tested like.
 */
export function createMockRenderer<TSettings = ManuscriptSettings>(options: MockRendererOptions = {}): MockRenderer<TSettings> {
  const calls: { ir: ManuscriptIR; settings: TSettings }[] = []
  return {
    format: 'text',
    mimeType: 'text/plain;charset=utf-8',
    fileExtension: 'txt',
    calls,
    async render(ir: ManuscriptIR, settings: TSettings, { signal, onProgress }: RenderOptions = {}): Promise<Uint8Array> {
      calls.push({ ir, settings })
      assertManuscriptVersion(ir)
      throwIfAborted(signal)
      const total = ir.chapters.length + 1
      onProgress?.({ fraction: 0, done: 0, total, stage: 'chapters' })
      for (let done = 1; done < total; done++) {
        await pause(options.delayMs ?? 0)
        throwIfAborted(signal)
        onProgress?.({ fraction: done / total, done, total, stage: 'chapters' })
      }
      const bytes = new TextEncoder().encode(manuscriptPlainText(ir, { footnotes: true }))
      throwIfAborted(signal)
      onProgress?.({ fraction: 1, done: total, total, stage: 'done' })
      return bytes
    },
  }
}
