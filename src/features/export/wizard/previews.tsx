import type { CSSProperties, ReactNode } from 'react'
import { FONT_FALLBACKS } from '../settings'
import type { ManuscriptSettings } from '../settings'
import type { InlineRun, ManuscriptIR } from '../ir'
import { contactLines, headerText, type TitlePageData } from './title-page'

/**
 * HTML previews of the manuscript's pages (no export runs): the title page, the running header and a
 * chapter's opening page, drawn to scale from the settings. The page is white with black text, as
 * the exported file is, in either theme.
 */

const PAPER_IN: Record<ManuscriptSettings['paper'], { w: number; h: number }> = { letter: { w: 8.5, h: 11 }, a4: { w: 8.27, h: 11.69 } }

/** The CSS font stack for a manuscript font: it, then its metric-compatible stand-ins. */
export function previewFontStack(family: string): string {
  const name = family.trim() || 'Times New Roman'
  const chain = FONT_FALLBACKS[name] ?? [name]
  const mono = /courier|mono/i.test(name)
  return [...new Set([name, ...chain])].map((f) => `"${f.replace(/["\\]/g, '')}"`).join(', ') + (mono ? ', monospace' : ', serif')
}

interface PageProps {
  settings: ManuscriptSettings
  /** Page width on screen (CSS length). */
  width?: string
  label: string
  children: ReactNode
}

/** A page to scale: `--in` is one inch, children place themselves in inches. */
function Page({ settings, width = '13rem', label, children }: PageProps) {
  const paper = PAPER_IN[settings.paper]
  const style = {
    '--in': `calc(${width} / ${paper.w})`,
    width,
    aspectRatio: `${paper.w} / ${paper.h}`,
    fontFamily: previewFontStack(settings.fontFamily),
    fontSize: `calc(var(--in) * ${settings.fontSizePt / 72})`,
    lineHeight: 1.15,
  } as CSSProperties
  return (
    <figure className="m-0 flex flex-col items-center gap-1.5">
      <div role="img" aria-label={label} className="relative shrink-0 overflow-hidden rounded-[2px] border border-border-control bg-white text-black shadow-raised" style={style}>
        {children}
      </div>
      <figcaption className="text-ui-xs text-text-muted">{label}</figcaption>
    </figure>
  )
}

const inch = (n: number) => `calc(var(--in) * ${n})`

function Runs({ runs, settings }: { runs: readonly InlineRun[]; settings: ManuscriptSettings }) {
  return (
    <>
      {runs.map((r, i) => {
        if (r.kind === 'lineBreak') return <br key={i} />
        if (r.kind !== 'text') return null
        const italic = r.italic && settings.italics === 'italic'
        const underline = r.underline || (r.italic && settings.italics === 'underline')
        return (
          <span key={i} style={{ fontStyle: italic ? 'italic' : undefined, fontWeight: r.bold ? 700 : undefined, textDecoration: underline ? 'underline' : undefined }}>
            {r.text}
          </span>
        )
      })}
    </>
  )
}

export function TitlePagePreview({ settings, data }: { settings: ManuscriptSettings; data: TitlePageData }) {
  const m = settings.margins
  const paper = PAPER_IN[settings.paper]
  const textHeight = paper.h - m.top - m.bottom
  const lines = contactLines(settings, data.contact)
  if (!settings.titlePage.include) {
    return (
      <Page settings={settings} label="Title page (none: the text starts on page 1)">
        <p className="absolute inset-x-0 top-1/2 m-0 text-center" style={{ fontSize: '0.6rem', fontFamily: 'inherit' }}>
          No title page
        </p>
      </Page>
    )
  }
  return (
    <Page settings={settings} label="Title page">
      <div data-testid="preview-contact" className="absolute" style={{ left: inch(m.left), top: inch(m.top), maxWidth: inch((paper.w - m.left - m.right) * 0.6) }}>
        {lines.map((l, i) => (
          <div key={i} className="truncate">
            {l}
          </div>
        ))}
      </div>
      {settings.titlePage.showWordCount ? (
        <div data-testid="preview-wordcount" className="absolute text-right" style={{ right: inch(m.right), top: inch(m.top) }}>
          {data.wordCountText}
        </div>
      ) : null}
      <div className="absolute text-center" style={{ left: inch(m.left), right: inch(m.right), top: inch(m.top + textHeight / 3), lineHeight: 2.3 }}>
        <div data-testid="preview-title" className="break-words">
          {data.title || '\u00a0'}
        </div>
        <div>&nbsp;</div>
        <div data-testid="preview-byline">{data.byline || '\u00a0'}</div>
      </div>
    </Page>
  )
}

/** The running header as printed on a page (default: the second page, the first one with a header). */
export function HeaderPreview({ settings, data, page = 2 }: { settings: ManuscriptSettings; data: TitlePageData; page?: number }) {
  const text = headerText(settings, data, page)
  return (
    <div className="rounded-control border border-border-control bg-white px-3 py-2 text-black" style={{ fontFamily: previewFontStack(settings.fontFamily) }}>
      <div className="mb-1 font-sans text-ui-xs text-[#3d464b]">Header, page {page}</div>
      <div data-testid="preview-header" className="text-right text-ui">
        {text || <span className="font-sans text-ui-xs text-[#3d464b]">No header</span>}
      </div>
    </div>
  )
}

export function ChapterPagePreview({ settings, data, ir }: { settings: ManuscriptSettings; data: TitlePageData; ir: ManuscriptIR | null }) {
  const m = settings.margins
  const paper = PAPER_IN[settings.paper]
  const textHeight = paper.h - m.top - m.bottom
  const chapter = ir?.chapters.find((c) => c.blocks.some((b) => b.kind === 'paragraph')) ?? ir?.chapters[0] ?? null
  const paragraphs = (chapter?.blocks ?? []).filter((b) => b.kind === 'paragraph').slice(0, 6)
  const header = headerText(settings, data, settings.titlePage.include ? 2 : 1)
  const pitch = settings.lineSpacing * 1.15
  return (
    <Page settings={settings} label="Chapter opening page">
      {header ? (
        <div data-testid="preview-page-header" className="absolute text-right" style={{ right: inch(m.right), top: inch(0.5) }}>
          {header}
        </div>
      ) : null}
      <div className="absolute overflow-hidden" style={{ left: inch(m.left), right: inch(m.right), top: inch(m.top + textHeight * settings.chapterDropFraction), bottom: inch(m.bottom), lineHeight: pitch }}>
        <div className="text-center">
          {chapter?.numberText ? <div><Runs runs={chapter.number} settings={settings} /></div> : null}
          <div>{chapter ? chapter.titleText ? <Runs runs={chapter.title} settings={settings} /> : '\u00a0' : 'Chapter One'}</div>
          <div>&nbsp;</div>
        </div>
        {paragraphs.length ? (
          paragraphs.map((b, i) =>
            b.kind === 'paragraph' ? (
              <p key={i} className="m-0" style={{ textIndent: i === 0 && !settings.indentFirstParagraph ? 0 : inch(settings.firstLineIndentIn), textAlign: b.align ?? 'left' }}>
                <Runs runs={b.runs} settings={settings} />
              </p>
            ) : null,
          )
        ) : (
          <p className="m-0" style={{ textIndent: inch(settings.firstLineIndentIn) }}>
            The text of the chapter starts here, double-spaced, every paragraph indented.
          </p>
        )}
      </div>
    </Page>
  )
}
