const BREAK_BEFORE = /(?:^|;)\s*(?:page-)?break-before\s*:\s*(?:always|page|left|right|recto|verso)\b/i
const BREAK_AFTER = /(?:^|;)\s*(?:page-)?break-after\s*:\s*(?:always|page|left|right|recto|verso)\b/i
const marker = (doc: Document) => {
  const el = doc.createElement('div')
  el.setAttribute('data-page-break', '')
  return el
}

/**
 * Maps pasted or imported HTML to the book's break nodes: an element with `page-break-before` /
 * `break-before: page` gets a page break node before it, `page-break-after` after it. (`<hr>` is
 * mapped to a scene break by the scene break node's own parse rule.) Limitation: `left`/`right`/`recto`/
 * `verso` are not distinguished; they become a plain page break, never a recto break. Wired to paste
 * only; an importer must call this itself. Returns the input unchanged
 * when it names no page break.
 */
export function mapPastedHtml(html: string): string {
  if (!/break-(?:before|after)/i.test(html)) return html
  const doc = new DOMParser().parseFromString(html, 'text/html')
  let changed = false
  for (const el of Array.from(doc.body.querySelectorAll<HTMLElement>('[style]'))) {
    const style = el.getAttribute('style') ?? ''
    if (BREAK_BEFORE.test(style)) {
      el.before(marker(doc))
      changed = true
    }
    if (BREAK_AFTER.test(style)) {
      el.after(marker(doc))
      changed = true
    }
  }
  return changed ? doc.body.innerHTML : html
}
