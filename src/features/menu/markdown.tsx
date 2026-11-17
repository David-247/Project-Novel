import type { ReactNode } from 'react'

/**
 * A small Markdown renderer for the bundled docs (Help > Project Folder Format): headings,
 * paragraphs, lists, fenced code and tables, with inline `code`, **bold** and *emphasis*. Text only,
 * never HTML: the output is React elements, so nothing in the file is executed or parsed as markup.
 */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*|\[[^\]]+\]\([^)]+\))/g
  let last = 0
  let k = 0
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push(text.slice(last, m.index))
    const t = m[0]
    if (t.startsWith('`')) out.push(<code key={k++} className="rounded bg-surface-hover px-1 font-mono text-ui-sm">{t.slice(1, -1)}</code>)
    else if (t.startsWith('**')) out.push(<strong key={k++}>{t.slice(2, -2)}</strong>)
    else if (t.startsWith('[')) out.push(t.slice(1, t.indexOf(']'))) // links: text only (offline)
    else out.push(<em key={k++}>{t.slice(1, -1)}</em>)
    last = m.index! + t.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export function renderMarkdown(md: string): ReactNode[] {
  const lines = md.replace(/\r\n?/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let i = 0
  let k = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') {
      i++
      continue
    }
    if (line.startsWith('```')) {
      const code: string[] = []
      i++
      while (i < lines.length && !lines[i].startsWith('```')) code.push(lines[i++])
      i++
      blocks.push(
        <pre key={k++} className="overflow-x-auto rounded-control bg-surface-hover p-2 font-mono text-ui-xs">
          {code.join('\n')}
        </pre>,
      )
      continue
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line)
    if (h) {
      const cls = ['text-ui-lg font-semibold', 'pt-2 text-ui font-semibold', 'pt-1 text-ui font-semibold', 'text-ui-sm font-semibold'][h[1].length - 1]
      const Tag = (`h${Math.min(h[1].length + 2, 6)}`) as 'h3'
      blocks.push(<Tag key={k++} className={cls}>{inline(h[2])}</Tag>)
      i++
      continue
    }
    if (line.trimStart().startsWith('|')) {
      const rows: string[] = []
      while (i < lines.length && lines[i].trimStart().startsWith('|')) rows.push(lines[i++])
      const cells = (r: string) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
      const body = rows.filter((r) => !/^\s*\|?\s*:?-{2,}/.test(r))
      blocks.push(
        <table key={k++} className="w-full border-collapse text-ui-sm">
          <tbody>
            {body.map((r, ri) => (
              <tr key={ri} className="border-t border-border align-top">
                {cells(r).map((c, ci) =>
                  ri === 0 ? (
                    <th key={ci} className="py-1 pr-2 text-left font-semibold">{inline(c)}</th>
                  ) : (
                    <td key={ci} className="py-1 pr-2">{inline(c)}</td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>,
      )
      continue
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line)
      const items: string[] = []
      while (i < lines.length && lines[i].trim() !== '' && !lines[i].startsWith('#') && !lines[i].startsWith('```')) {
        const m = /^\s*([-*]|\d+\.)\s+(.*)$/.exec(lines[i])
        if (m) items.push(m[2])
        else items[items.length - 1] += ` ${lines[i].trim()}`
        i++
      }
      const List = ordered ? 'ol' : 'ul'
      blocks.push(
        <List key={k++} className={ordered ? 'list-decimal pl-5' : 'list-disc pl-5'}>
          {items.map((t, ti) => (
            <li key={ti}>{inline(t)}</li>
          ))}
        </List>,
      )
      continue
    }
    const para: string[] = []
    while (i < lines.length && lines[i].trim() !== '' && !/^(#{1,4}\s|```|\s*\||\s*([-*]|\d+\.)\s)/.test(lines[i])) para.push(lines[i++].trim())
    if (para.length === 0) para.push(lines[i++].trim()) // never stall on an unexpected line
    blocks.push(<p key={k++}>{inline(para.join(' '))}</p>)
  }
  return blocks
}
