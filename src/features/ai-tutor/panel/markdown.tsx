import { Fragment, type ReactNode } from 'react'

/**
 * The tutor's replies (and the scripted ones) are Markdown. This renders the small subset chat replies
 * use, as React elements (never HTML, so nothing in a reply can inject markup): paragraphs, line
 * breaks, bullet and numbered lists, headings (as bold lines), block quotes, **bold**, *italic*, `code`.
 * Anything else is shown as the text it is.
 */

const INLINE = /(\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|\*[^*\s][^*\n]*\*|_[^_\s][^_\n]*_)/g

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let n = 0
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0
    if (at > last) out.push(text.slice(last, at))
    const t = m[0]
    const k = `${key}-${n++}`
    if (t.startsWith('**') || t.startsWith('__')) out.push(<strong key={k}>{t.slice(2, -2)}</strong>)
    else if (t.startsWith('`')) out.push(<code key={k} className="nv-tutor-code">{t.slice(1, -1)}</code>)
    else out.push(<em key={k}>{t.slice(1, -1)}</em>)
    last = at + t.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

/** Lines joined with line breaks, each with its inline marks. */
function lines(list: string[], key: string): ReactNode[] {
  return list.map((l, i) => (
    <Fragment key={`${key}-${i}`}>
      {i > 0 ? <br /> : null}
      {inline(l, `${key}-${i}`)}
    </Fragment>
  ))
}

type Block = { kind: 'p' | 'quote' | 'heading'; lines: string[] } | { kind: 'ul' | 'ol'; items: string[] }

const BULLET = /^\s*[-*•]\s+/
const NUMBER = /^\s*\d+[.)]\s+/
const HEADING = /^\s*#{1,6}\s+/
const QUOTE = /^\s*>\s?/

function blocks(source: string): Block[] {
  const out: Block[] = []
  let cur = null as Block | null
  const flush = () => {
    if (cur) out.push(cur)
    cur = null
  }
  for (const raw of source.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trimEnd()
    if (!line.trim()) {
      flush()
      continue
    }
    if (BULLET.test(line) || NUMBER.test(line)) {
      const kind = BULLET.test(line) ? 'ul' : 'ol'
      const item = line.replace(kind === 'ul' ? BULLET : NUMBER, '')
      if (cur?.kind !== kind) {
        flush()
        cur = { kind, items: [] }
      }
      ;(cur as { items: string[] }).items.push(item)
      continue
    }
    if (HEADING.test(line)) {
      flush()
      out.push({ kind: 'heading', lines: [line.replace(HEADING, '')] })
      continue
    }
    if (QUOTE.test(line)) {
      if (cur?.kind !== 'quote') {
        flush()
        cur = { kind: 'quote', lines: [] }
      }
      ;(cur as { lines: string[] }).lines.push(line.replace(QUOTE, ''))
      continue
    }
    // A line under a list item continues it.
    if (cur && (cur.kind === 'ul' || cur.kind === 'ol') && /^\s{2,}/.test(raw)) {
      cur.items[cur.items.length - 1] += ` ${line.trim()}`
      continue
    }
    if (cur?.kind !== 'p') {
      flush()
      cur = { kind: 'p', lines: [] }
    }
    ;(cur as { lines: string[] }).lines.push(line)
  }
  flush()
  return out
}

export function Markdown({ source }: { source: string }) {
  return (
    <div className="nv-tutor-md">
      {blocks(source).map((b, i) => {
        const key = `b${i}`
        switch (b.kind) {
          case 'ul':
            return (
              <ul key={key}>
                {b.items.map((it, j) => (
                  <li key={j}>{inline(it, `${key}-${j}`)}</li>
                ))}
              </ul>
            )
          case 'ol':
            return (
              <ol key={key}>
                {b.items.map((it, j) => (
                  <li key={j}>{inline(it, `${key}-${j}`)}</li>
                ))}
              </ol>
            )
          case 'heading':
            return (
              <p key={key} className="font-semibold">
                {lines(b.lines, key)}
              </p>
            )
          case 'quote':
            return <blockquote key={key}>{lines(b.lines, key)}</blockquote>
          default:
            return <p key={key}>{lines(b.lines, key)}</p>
        }
      })}
    </div>
  )
}
