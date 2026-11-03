// Pagination spike (ADR evidence for docs/pagination.md). Not part of the app or the test suite.
//
//   node scripts/pagination-spike.mjs            # chromium + webkit
//   node scripts/pagination-spike.mjs webkit     # one engine
//
// Builds the Phase 1 perf manuscript (100,000 words, 960 paragraphs + 40 headings) as a plain
// contenteditable in a static page and measures candidate layout strategies in real engines:
//
//  A. "measure-and-break": a single vertical column of page width. Line boxes of every block are
//     measured (Range.getClientRects), page breaks are computed in JS (widows/orphans 2), and a
//     spacer element is inserted at every break (what page-gap widget decorations would do).
//  B. "css-multicol": the contenteditable itself is a CSS multi-column container whose columns are
//     the pages (column-width = text block width, height = text block height, column-fill: auto).
//     The engine does the line-level fragmentation (widows/orphans 2); JS only reads the page map.
//  C. "multicol + containment" (hybrid): B, plus blocks that do not straddle a page boundary get
//     `content-visibility: auto` with their measured height, so off-screen pages cost ~nothing.
//
// For each: initial layout, trim change (5.5x8.5 -> 6x9, full reflow + page map), and typing
// latency (real key presses, keydown -> next frame painted, median of 30 after 5 warm-up).
import { chromium, webkit } from '@playwright/test'

const WORDS = 100_000
const VOCAB = [
  'night', 'river', 'quiet', 'lantern', 'stone', 'window', 'garden', 'letter', 'morning', 'shadow',
  'silver', 'harbor', 'whisper', 'meadow', 'candle', 'thunder', 'orchard', 'ribbon', 'compass', 'feather',
]

function manuscriptHTML() {
  let n = 0
  const word = () => (n++ % 10 === 0 ? 'the' : VOCAB[(n * 7) % VOCAB.length])
  const out = []
  for (let p = 0; n < WORDS; p++) {
    const words = Array.from({ length: Math.min(100, WORDS - n) }, word)
    if (p % 25 === 0) out.push(`<h2>${words.slice(0, 6).join(' ')}</h2>`)
    else out.push(`<p>${words.slice(0, 10).join(' ')} <strong>${words.slice(10, 15).join(' ')}</strong> ${words.slice(15).join(' ')}</p>`)
  }
  return out.join('')
}

// 96 px per inch; margins 54/54/63/45 pt -> 72/72/84/60 px.
const TRIMS = {
  'us-5.5x8.5': { w: 528, h: 816 },
  'us-6x9': { w: 576, h: 864 },
}
const M = { top: 72, bottom: 72, inside: 84, outside: 60 }
const box = (t) => ({ cw: TRIMS[t].w - M.inside - M.outside, ch: TRIMS[t].h - M.top - M.bottom })
const ONLY = process.argv[3]

const PAGE = `<!doctype html><html><head><style>
  body { margin: 0; }
  #scroller { position: fixed; inset: 0; overflow: auto; }
  #ed { outline: none; font: 15px/1.45 Georgia, 'Times New Roman', serif; white-space: pre-wrap; word-wrap: break-word; }
  #ed p { margin: 0; text-indent: 1.5em; text-align: justify; widows: 2; orphans: 2; }
  #ed h2 { font-size: 1.6em; margin: 1.2em 0 0.8em; break-after: avoid; }
  #ed .spacer { display: block; }
  #ed > * { pointer-events: auto; }
</style></head><body><div id="scroller"><div id="ed" contenteditable="true"></div></div></body></html>`

/* eslint-disable no-undef */
const pageFns = {
  // Strategy A setup + full measure/break/insert pass. Returns timings.
  measureAndBreak: ({ html, cw, ch, gap }) => {
    const ed = document.getElementById('ed')
    const t0 = performance.now()
    if (html) ed.innerHTML = html
    ed.querySelectorAll('.spacer').forEach((s) => s.remove())
    ed.normalize()
    ed.style.cssText = `width:${cw}px; margin: 0 auto;`
    void ed.offsetHeight
    const tLayout = performance.now()
    // Measure line boxes of every block.
    const blocks = [...ed.children]
    const edTop = ed.getBoundingClientRect().top
    const r = document.createRange()
    const lines = [] // { block, top, bottom, x }
    for (const b of blocks) {
      r.selectNodeContents(b)
      const rects = r.getClientRects()
      let last = null
      for (const rc of rects) {
        if (rc.height === 0) continue
        if (last && rc.top < last.bottom - 1) { last.bottom = Math.max(last.bottom, rc.bottom - edTop); continue }
        last = { block: b, top: rc.top - edTop, bottom: rc.bottom - edTop, x: rc.left }
        lines.push(last)
      }
    }
    const tMeasure = performance.now()
    // Break: lines into pages of height ch, widows/orphans 2.
    const breaks = [] // index into lines where a page starts
    let pageTop = 0
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].bottom - pageTop > ch) {
        let k = i
        const blk = lines[i].block
        const firstOfBlock = lines.findIndex((l) => l.block === blk)
        let lastOfBlock = k
        while (lastOfBlock + 1 < lines.length && lines[lastOfBlock + 1].block === blk) lastOfBlock++
        if (k - firstOfBlock < 2) k = firstOfBlock // orphans
        else if (lastOfBlock - k + 1 < 2) k = Math.max(firstOfBlock, lastOfBlock - 1) // widows
        if (k <= (breaks.at(-1) ?? -1)) k = i
        breaks.push(k)
        pageTop = lines[k].top
        i = k
      }
    }
    const tBreak = performance.now()
    // Insert spacers at line starts (caret position from point), back to front.
    const caretAt = (x, y) => {
      if (document.caretPositionFromPoint) { const p = document.caretPositionFromPoint(x, y); return p && { node: p.offsetNode, offset: p.offset } }
      const rr = document.caretRangeFromPoint(x, y); return rr && { node: rr.startContainer, offset: rr.startOffset }
    }
    const points = breaks.map((k) => {
      const l = lines[k]
      const firstOfBlock = lines.findIndex((x) => x.block === l.block) === k
      if (firstOfBlock) return { before: l.block }
      return { pos: caretAt(l.x + 1, l.top + edTop + (l.bottom - l.top) / 2) }
    })
    const tCaret = performance.now()
    for (let i = points.length - 1; i >= 0; i--) {
      const s = document.createElement('span')
      s.className = 'spacer'
      s.contentEditable = 'false'
      s.style.height = '240px'
      const p = points[i]
      if (p.before) p.before.before(s)
      else if (p.pos && p.pos.node.nodeType === 3) p.pos.node.splitText(p.pos.offset).before(s)
      else if (p.pos) p.pos.node.insertBefore(s, p.pos.node.childNodes[p.pos.offset] ?? null)
    }
    void ed.offsetHeight
    const tEnd = performance.now()
    return {
      pages: breaks.length + 1,
      layoutMs: tLayout - t0,
      measureLinesMs: tMeasure - tLayout,
      breakMs: tBreak - tMeasure,
      caretLookupMs: tCaret - tBreak,
      insertAndRelayoutMs: tEnd - tCaret,
      totalMs: tEnd - t0,
    }
  },

  // Strategy B/C setup: the contenteditable is the multicol container. Returns timings + page map cost.
  multicol: ({ html, cw, ch, gap, contain }) => {
    const ed = document.getElementById('ed')
    const t0 = performance.now()
    if (html) ed.innerHTML = html
    for (const b of ed.children) { b.style.contentVisibility = ''; b.style.containIntrinsicSize = '' }
    ed.style.cssText = `column-width:${cw}px; column-gap:${gap}px; column-fill:auto; height:${ch}px; width:${cw * 2 + gap}px; margin-left: 40px;`
    void ed.scrollWidth
    const tLayout = performance.now()
    // Page map: the column(s) of every block, from its fragment rects.
    const edRect = ed.getBoundingClientRect()
    const stride = cw + gap
    let pages = 0
    let straddling = 0
    const info = []
    for (const b of ed.children) {
      const rects = b.getClientRects()
      const first = Math.round((rects[0].left - edRect.left) / stride)
      const last = Math.round((rects[rects.length - 1].left - edRect.left) / stride)
      if (last !== first) straddling++
      pages = Math.max(pages, last + 1)
      info.push({ b, first, last, h: b.offsetHeight })
    }
    const tMap = performance.now()
    let tContain = tMap
    if (contain) {
      for (const { b, first, last, h } of info) {
        if (first === last && first > 3) { b.style.containIntrinsicSize = `auto ${h}px`; b.style.contentVisibility = 'auto' }
      }
      void ed.scrollWidth
      tContain = performance.now()
    }
    // Page count after containment (must not change).
    const edRect2 = ed.getBoundingClientRect()
    const lastRects = ed.lastElementChild.getClientRects()
    const pagesAfter = Math.round((lastRects[lastRects.length - 1].left - edRect2.left) / stride) + 1
    return { pages, pagesAfter, straddling, layoutMs: tLayout - t0, pageMapMs: tMap - tLayout, containMs: tContain - tMap, totalMs: tContain - t0 }
  },

  // Strategy D (hybrid "shifted stream"): A's measured breaks, but no spacers. The stream stays a
  // natural single column; every page's content is moved to its place in the spread with
  // position:relative offsets (whole blocks: block offset; the lines of a block that continue on the
  // next page: an inline wrapper with the offset difference). Layout (line breaking) never depends
  // on the offsets, so measuring is never fed back by its own result.
  shifted: ({ html, cw, ch, pw, ph, m }) => {
    const ed = document.getElementById('ed')
    const t0 = performance.now()
    if (html) ed.innerHTML = html
    ed.querySelectorAll('span.tail').forEach((s) => s.replaceWith(...s.childNodes))
    for (const b of ed.children) { b.style.position = ''; b.style.left = ''; b.style.top = ''; b.normalize() }
    ed.style.cssText = `width:${cw}px; position:relative; pointer-events:none;`
    void ed.offsetHeight
    const tLayout = performance.now()
    const edTop = ed.getBoundingClientRect().top
    const lines = []
    const r = document.createRange()
    const blocks = [...ed.children]
    blocks.forEach((b, bi) => {
      const w = document.createTreeWalker(b, NodeFilter.SHOW_TEXT)
      let cur = null
      for (let t = w.nextNode(); t; t = w.nextNode()) {
        r.selectNodeContents(t)
        for (const rc of r.getClientRects()) {
          const top = rc.top - edTop, bottom = rc.bottom - edTop, mid = (top + bottom) / 2
          if (cur && mid >= cur.top && mid <= cur.bottom) { cur.bottom = Math.max(cur.bottom, bottom); continue }
          cur = { bi, top, bottom, node: t }
          lines.push(cur)
        }
      }
    })
    const tMeasure = performance.now()
    const starts = [0]
    let pageTop = lines[0].top
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].bottom - pageTop > ch) {
        let k = i
        const bi = lines[i].bi
        let f = k; while (f > 0 && lines[f - 1].bi === bi) f--
        let l = k; while (l + 1 < lines.length && lines[l + 1].bi === bi) l++
        if (k - f < 2) k = f
        else if (l - k + 1 < 2) k = Math.max(f, l - 1)
        if (k <= starts.at(-1)) k = i
        starts.push(k)
        pageTop = lines[k].top
        i = k
      }
    }
    const tBreak = performance.now()
    // Line-start text position of every mid-block break (binary search on character rects).
    const splitAt = new Map() // line index -> { node, offset }
    for (const k of starts) {
      if (k === 0 || lines[k - 1].bi !== lines[k].bi) continue
      const L = lines[k]
      // First text node of the line is L.node; binary search the first char whose top >= L.top - 1.
      const t = L.node
      let lo = 0, hi = t.length
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        r.setStart(t, mid); r.setEnd(t, mid + 1)
        const rc = r.getBoundingClientRect()
        if (rc.top - edTop >= L.top - 1) hi = mid
        else lo = mid + 1
      }
      splitAt.set(k, { node: t, offset: lo })
    }
    const tLookup = performance.now()
    // Page placement (spread: page 0 is a recto) and offsets.
    const pad = 24, rowGap = 24
    const target = (i) => {
      const verso = i % 2 === 1
      const row = Math.floor((i + 1) / 2)
      const x = (verso ? pad : pad + pw) + (verso ? m.outside : m.inside)
      const y = pad + row * (ph + rowGap) + m.top
      return { x, y }
    }
    const pageOfLine = new Int32Array(lines.length)
    starts.forEach((s, p) => { const e = starts[p + 1] ?? lines.length; for (let i = s; i < e; i++) pageOfLine[i] = p })
    const off = starts.map((s, p) => { const t = target(p); return { dx: t.x, dy: t.y - lines[s].top } })
    let li = 0
    blocks.forEach((b, bi) => {
      if (li >= lines.length || lines[li].bi !== bi) return
      const p0 = pageOfLine[li]
      b.style.position = 'relative'; b.style.left = off[p0].dx + 'px'; b.style.top = off[p0].dy + 'px'
      // Tails, back to front so earlier split points stay valid.
      const tails = []
      while (li < lines.length && lines[li].bi === bi) { if (splitAt.has(li)) tails.push(li); li++ }
      for (const k of tails.reverse()) {
        const { node, offset } = splitAt.get(k)
        const p = pageOfLine[k]
        const rest = offset > 0 ? node.splitText(offset) : node
        let start = rest
        while (start.parentNode !== b && start.parentNode !== null && !(start.parentNode.classList?.contains('tail'))) start = start.parentNode
        const span = document.createElement('span')
        span.className = 'tail'
        span.style.position = 'relative'
        span.style.left = off[p].dx - off[p0].dx + 'px'
        span.style.top = off[p].dy - off[p0].dy + 'px'
        const parent = start.parentNode
        const moved = []
        for (let n = start; n; n = n.nextSibling) moved.push(n)
        parent.append(span)
        span.append(...moved)
      }
    })
    void ed.offsetHeight
    const tApply = performance.now()
    // Verify: the first line of every page is painted at its page's text-block top.
    let misplaced = 0
    const wrapTop = ed.getBoundingClientRect().top
    starts.forEach((s, p) => {
      const L = lines[s]
      const rr = document.createRange()
      if (splitAt.has(s)) { const sp = splitAt.get(s); rr.setStart(sp.node.nextSibling && sp.offset > 0 ? sp.node.nextSibling : sp.node, 0) }
      else rr.setStart(L.node, 0)
      rr.setEnd(rr.startContainer, Math.min(1, rr.startContainer.length ?? 1))
      const top = rr.getBoundingClientRect().top - wrapTop
      if (Math.abs(top - target(p).y) > 1) misplaced++
    })
    return {
      pages: starts.length,
      misplaced,
      layoutMs: tLayout - t0,
      measureLinesMs: tMeasure - tLayout,
      breakMs: tBreak - tMeasure,
      lineStartLookupMs: tLookup - tBreak,
      applyAndRelayoutMs: tApply - tLookup,
      totalMs: tApply - t0,
    }
  },

  probe: () => {
    window.__perf = []
    window.addEventListener('keydown', (e) => {
      const t0 = performance.now()
      requestAnimationFrame(() => {
        const c = new MessageChannel()
        c.port1.onmessage = () => window.__perf.push(performance.now() - t0)
        c.port2.postMessage(null)
      })
    }, true)
  },
}
/* eslint-enable no-undef */

async function typing(page) {
  await page.evaluate(pageFns.probe)
  // Caret at the end of paragraph 500, scrolled into view.
  await page.evaluate(() => {
    const p = document.querySelectorAll('#ed p')[500]
    p.scrollIntoView({ block: 'center', inline: 'center' })
    const r = document.createRange(); r.selectNodeContents(p); r.collapse(false)
    const s = getSelection(); s.removeAllRanges(); s.addRange(r)
    document.getElementById('ed').focus()
  })
  const keys = 'abcdefghijklmnopqrstuvwxyzabcdefghij'
  for (let i = 0; i < keys.length; i++) {
    await page.keyboard.press(keys[i])
    await page.waitForFunction((k) => window.__perf.length >= k, i + 1)
  }
  const s = (await page.evaluate(() => window.__perf)).slice(5).sort((a, b) => a - b)
  return { median: +s[Math.floor(s.length / 2)].toFixed(1), p95: +s[Math.floor(s.length * 0.95)].toFixed(1) }
}

const round = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' ? +v.toFixed(1) : v]))

async function run(browserType) {
  const browser = await browserType.launch()
  const html = manuscriptHTML()
  const results = {}
  const a = box('us-5.5x8.5')
  const b = box('us-6x9')
  const gap = 2 * M.inside

  for (const [name, fn, extra] of [
    ['A measure-and-break', 'measureAndBreak', {}],
    ['B css-multicol', 'multicol', { contain: false }],
    ['C multicol+containment', 'multicol', { contain: true }],
    ['D shifted stream (hybrid)', 'shifted', {}],
  ]) {
    if (ONLY && !name.startsWith(ONLY)) continue
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
    await page.setContent(PAGE)
    const call = (args) => page.evaluate(pageFns[fn], args)
    const g = (t) => ({ ...box(t), pw: TRIMS[t].w, ph: TRIMS[t].h, m: M, gap, ...extra })
    const initial = await call({ html, ...g('us-5.5x8.5') })
    const trim = await call({ html: null, ...g('us-6x9') })
    const back = await call({ html: null, ...g('us-5.5x8.5') })
    const t = await typing(page)
    results[name] = { initial: round(initial), trimTo6x9: round(trim), trimBack: round(back), typingMs: t }
    await page.close()
  }
  await browser.close()
  return results
}

const which = process.argv[2]
for (const [name, bt] of [['chromium', chromium], ['webkit', webkit]]) {
  if (which && which !== name) continue
  const r = await run(bt)
  console.log(`\n=== ${name} ===`)
  console.log(JSON.stringify(r, null, 1))
}
