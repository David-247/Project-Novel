import type { CSSProperties } from 'react'
import { styleToInlineCSS, type ResolvedStyle } from '@/shared/book'
import { SYSTEM_FONT_STACK } from '../fonts'

export const SAMPLE_TEXT =
  'The harbor lights came on one by one, and Mara counted them the way her father had taught her, slowly, as if each one might be the last.'
const BEFORE_TEXT = 'The rain had stopped an hour ago. Nobody on the quay had noticed.'
const AFTER_TEXT = 'By the time she reached the end of the pier, the boat was already gone.'

const BREAK_LABEL = { page: 'New page', recto: 'New right-hand page' } as const

export interface StyleProofProps {
  style: ResolvedStyle
  /** Style of the paragraphs around the sample (usually Body). */
  context: ResolvedStyle
  /** Style of the paragraph after the sample (the style's next style). */
  next: ResolvedStyle
  /** The writer's own words when available. */
  sample?: string
}

const css = (s: ResolvedStyle) => styleToInlineCSS(s) as CSSProperties

/**
 * A slice of the manuscript set in the style being edited: the paragraph before it (muted), a page
 * break mark when the style starts a page, the sample, and the next paragraph. Book points use the
 * writing view's scale, slightly reduced, so a chapter title fits.
 */
export function StyleProof({ style, context, next, sample }: StyleProofProps) {
  const brk = style.breakBefore === 'page' || style.breakBefore === 'recto' ? style.breakBefore : null
  return (
    <figure
      aria-label="Preview"
      data-testid="style-proof"
      className="m-0 overflow-hidden rounded-panel border border-border bg-surface px-5 py-4 text-text"
      style={{ fontFamily: SYSTEM_FONT_STACK, ['--nv-pt' as string]: 'calc(0.95rem / 11)', fontSize: '0.95rem' }}
    >
      <p aria-hidden="true" className="m-0 text-text-muted" style={{ ...css(context), marginBottom: 0 }}>
        {BEFORE_TEXT}
      </p>
      {brk ? (
        <div aria-hidden="true" className="my-3 flex items-center gap-2 text-ui-xs text-text-muted" style={{ fontFamily: 'var(--font-sans)' }}>
          <span className="h-px flex-1 border-t border-dashed border-border-control" />
          <span>{BREAK_LABEL[brk]}</span>
          <span className="h-px flex-1 border-t border-dashed border-border-control" />
        </div>
      ) : null}
      <p className="m-0" data-testid="style-proof-sample" style={css(style)}>
        {sample?.trim() ? sample.trim() : SAMPLE_TEXT}
      </p>
      <p aria-hidden="true" className="m-0 text-text-muted" style={css(next)}>
        {AFTER_TEXT}
      </p>
      <figcaption className="sr-only">Preview of the style with the paragraphs around it.</figcaption>
    </figure>
  )
}
