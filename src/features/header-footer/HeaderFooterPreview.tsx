import { useMemo } from 'react'
import { resolvePageGeometry } from '@/features/pagination'
import { makeHeaderFooterResolver, ptToPx, type HFChapter, type HFPage, type HeaderFooterSettings } from '@/shared/book'
import type { Margins, TrimSizeId } from '@/shared/book'
import { RunningHeadView, useRunningHeadCSS } from './RunningHeadView'

/**
 * A made-up layout the preview resolves with the very function the real pages use
 * (`makeHeaderFooterResolver`): a title page and a blank-ish verso as front matter, the first
 * chapter opening on a right-hand page, then two pages of the chapter.
 *   0 recto front matter, 1 verso front matter, 2 recto chapter opening, 3 verso, 4 recto
 */
export function previewLayout(chapterTitle: string): { pages: HFPage[]; chapters: HFChapter[] } {
  const mk = (index: number, chapterIndex: number): HFPage => ({
    index,
    side: index % 2 === 0 ? 'recto' : 'verso',
    from: index * 100,
    to: index * 100 + 100,
    isBlank: false,
    chapterIndex,
  })
  return {
    pages: [mk(0, -1), mk(1, -1), mk(2, 0), mk(3, 0), mk(4, 0)],
    chapters: [{ index: 0, title: chapterTitle, from: 200 }],
  }
}

const SPREADS: ReadonlyArray<{ caption: string; pages: readonly [number, number] }> = [
  { caption: 'Chapter opening', pages: [1, 2] },
  { caption: 'Inside the chapter', pages: [3, 4] },
]

const PREVIEW_PAGE_WIDTH = 140
/** Type in the preview is drawn this much larger than true to scale, so the words can be read. */
const TEXT_BOOST = 2.2

export interface HeaderFooterPreviewProps {
  settings: HeaderFooterSettings
  title: string
  author: string
  chapterTitle: string
  trimSize: TrimSizeId
  margins: Margins
}

/** Two miniature spreads showing what the current settings do to the pages. */
export function HeaderFooterPreview({ settings, title, author, chapterTitle, trimSize, margins }: HeaderFooterPreviewProps) {
  const geometry = useMemo(() => resolvePageGeometry(trimSize, margins), [trimSize, margins])
  const css = useRunningHeadCSS()
  const resolve = useMemo(() => {
    const { pages, chapters } = previewLayout(chapterTitle)
    return { pages, resolve: makeHeaderFooterResolver(pages, chapters, settings, { title, author }) }
  }, [settings, title, author, chapterTitle])

  const k = PREVIEW_PAGE_WIDTH / geometry.pageWidth
  const height = geometry.pageHeight * k
  const pt = ptToPx(1) * k * TEXT_BOOST

  return (
    <div className="nv-hf-preview" data-testid="hf-preview" style={{ ['--nv-pt' as string]: `${pt}px` }}>
      {SPREADS.map((spread) => (
        <figure key={spread.caption} className="nv-hf-figure">
          <div className="nv-hf-spread">
            {spread.pages.map((index) => {
              const page = resolve.pages[index]
              const r = resolve.resolve(page)
              const left = (page.side === 'verso' ? geometry.margins.outside : geometry.margins.inside) * k
              const width = geometry.contentWidth * k
              return (
                <div
                  key={index}
                  className={`nv-hf-minipage nv-page nv-page--${page.side}`}
                  data-preview-page={index}
                  data-side={page.side}
                  style={{ width: PREVIEW_PAGE_WIDTH, height }}
                >
                  <div className="nv-hf-slot nv-page-muted" data-region="header" style={{ left, width, right: 'auto', top: 0, height: geometry.margins.top * k }}>
                    <RunningHeadView region="header" resolved={r} css={css} />
                  </div>
                  <div className="nv-hf-body" style={{ left, width, top: geometry.margins.top * k + 2, height: Math.max(0, geometry.contentHeight * k - 4) }} aria-hidden="true">
                    {Array.from({ length: Math.max(0, Math.floor((geometry.contentHeight * k) / 5)) }, (_, i) => (
                      <i key={i} />
                    ))}
                  </div>
                  <div className="nv-hf-slot nv-page-muted" data-region="footer" style={{ left, width, right: 'auto', bottom: 0, height: geometry.margins.bottom * k }}>
                    <RunningHeadView region="footer" resolved={r} css={css} />
                  </div>
                </div>
              )
            })}
          </div>
          <figcaption>{spread.caption}</figcaption>
        </figure>
      ))}
    </div>
  )
}
