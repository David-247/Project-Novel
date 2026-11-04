import { memo, useMemo } from 'react'
import type { CSSProperties } from 'react'
import { STYLE_IDS, styleToInlineCSS, type ResolvedHeaderFooter } from '@/shared/book'
import { useResolvedStyles } from '@/features/editor'
import './header-footer.css'

export type HFRegion = 'header' | 'footer'

/** Inline CSS of the Running Head style (the book's own definition, so editing the style restyles heads). */
export function useRunningHeadCSS(): CSSProperties {
  const styles = useResolvedStyles()
  return useMemo(() => {
    const s = styles.get(STYLE_IDS.runningHead)
    if (!s) return {}
    // Spacing and indents belong to paragraphs in a flow; the slot is a box in the margin.
    const css = styleToInlineCSS(s)
    delete css.marginTop
    delete css.marginBottom
    delete css.marginLeft
    delete css.marginRight
    delete css.textIndent
    return css as CSSProperties
  }, [styles])
}

/**
 * The text of one region (header or footer) of one page, as `resolveHeaderFooter` decided. Shared by
 * the real pages and the dialog's mini preview. Renders nothing for an empty region.
 */
export const RunningHeadView = memo(function RunningHeadView({
  region,
  resolved,
  css,
}: {
  region: HFRegion
  resolved: Pick<ResolvedHeaderFooter, 'headerText' | 'number' | 'numberPosition' | 'side'>
  css: CSSProperties
}) {
  const { headerText, number, numberPosition, side } = resolved
  const numberHere = number && numberPosition && (region === 'header' ? numberPosition === 'header-outside' : numberPosition !== 'header-outside')
  const text = region === 'header' ? headerText : ''
  if (!text && !numberHere) return null
  const outside = numberPosition === 'footer-outside' || numberPosition === 'header-outside'
  return (
    <div className="nv-hf-line" data-hf-region={region} data-side={side} style={css}>
      {text ? (
        <span className="nv-hf-text" data-hf="text">
          {text}
        </span>
      ) : null}
      {numberHere ? (
        <span
          className={outside ? `nv-hf-number nv-hf-number--outside nv-hf-number--${side}` : 'nv-hf-number'}
          data-hf="number"
        >
          {number}
        </span>
      ) : null}
    </div>
  )
})
