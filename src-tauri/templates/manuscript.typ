// Manuscript template (Phase 4 PDF export): standard manuscript format, docs/manuscript-format.md.
// The PDF generator (src/features/export/pdf/data.ts, `buildPdfData`) writes everything this
// template places into data.json: lengths in pt, every string final. Manuscript text only ever
// reaches Typst as JSON strings shown with `text()`, never as markup, so "#", "$", "[" ... print as
// typed. sys.inputs (set by Rust): `font` (the chosen family) and `font-fallback` (the bundled one).
// No package imports and no eval: export is fully offline (src-tauri/src/export/templates.rs).
#let data = json("data.json")
#let T = data.type
#let pt(n) = n * 1pt
#let pitch = pt(T.pitch)

#set document(title: data.document.title, author: if data.document.author == "" { () } else { (data.document.author,) })
#set text(
  font: (sys.inputs.at("font"), sys.inputs.at("font-fallback")),
  size: pt(T.size),
  lang: data.document.lang,
  // The line box is the font's ascender to descender (hhea), so `leading` is the documented gap and
  // the baseline pitch equals Word's (2 x single line height for double spacing).
  top-edge: T.topEdge * 1em,
  bottom-edge: T.bottomEdge * 1em,
  hyphenate: false,
  ligatures: false,
  fill: black,
)
// `spacing` equals `leading`: the pitch is the same between paragraphs as inside them.
#set par(leading: pt(T.leading), spacing: pt(T.leading), justify: false, first-line-indent: 0pt)
#set block(spacing: pt(T.leading))
#set footnote.entry(separator: line(length: 2in, stroke: 0.5pt + black), clearance: pitch, gap: pt(T.singleLeading), indent: 0pt)
#show footnote.entry: set par(leading: pt(T.singleLeading), first-line-indent: 0pt)
#show footnote.entry: set text(size: pt(T.size))

#set page(
  paper: data.page.paper,
  margin: (
    top: pt(data.page.margin.top),
    right: pt(data.page.margin.right),
    bottom: pt(data.page.margin.bottom),
    left: pt(data.page.margin.left),
  ),
  header-ascent: pt(data.header.ascent),
  header: context {
    let n = counter(page).get().first()
    if data.header.show and n >= data.header.from {
      align(right, text(data.header.prefix + str(n - data.header.offset)))
    }
  },
  footer: none,
)

// ---- runs -----------------------------------------------------------------------------------------

#let styled(r) = {
  let c = text(r.s)
  if r.at("b", default: false) { c = text(weight: "bold", c) }
  if r.at("i", default: false) { c = text(style: "italic", c) }
  if r.at("u", default: false) { c = underline(c) }
  if r.at("sc", default: false) { c = smallcaps(c) }
  if r.at("sup", default: false) { c = super(c) }
  if r.at("sub", default: false) { c = sub(c) }
  c
}

#let plain-runs(rs) = {
  for r in rs {
    if "br" in r { linebreak() } else { styled(r) }
  }
}

#let runs(rs) = {
  for r in rs {
    if "br" in r { linebreak() } else if "fn" in r {
      let n = r.n
      // The entry reads "1 Note text": a no-break space between the raised number and the text
      // (the DOCX generator should match it). The reference in the running text is the number alone.
      footnote(numbering: (..) => n, [#text("\u{a0}")#plain-runs(r.fn)])
    } else { styled(r) }
  }
}

#let centred(body) = align(center, par(body))

// ---- blocks ---------------------------------------------------------------------------------------

#let block-of(b) = {
  if b.t == "p" {
    let p = par(first-line-indent: (amount: if b.indent { pt(T.indent) } else { 0pt }, all: true), runs(b.runs))
    let p = if b.align == "center" { align(center, p) } else if b.align == "right" { align(right, p) } else { p }
    if b.pad.at(0) > 0 or b.pad.at(1) > 0 { pad(left: pt(b.pad.at(0)), right: pt(b.pad.at(1)), p) } else { p }
  } else if b.t == "li" {
    // The marker's box ends at the text's indent (`hang`). A wider marker ("100.") ends at the next
    // default tab stop after it (every 0.5 in from the margin), as the tab after Word's marker does.
    let marker = context {
      let w = measure(text(b.marker)).width
      let width = if w < pt(b.hang) { pt(b.hang) } else { (calc.floor((pt(b.pad) + w) / 36pt) + 1) * 36pt - pt(b.pad) }
      box(width: width, text(b.marker))
    }
    pad(left: pt(b.pad), par(hanging-indent: pt(b.hang))[#marker#runs(b.runs)])
  } else if b.t == "opening" {
    pagebreak(weak: true)
    v(pt(data.chapterDrop))
    for l in b.lines { centred(runs(l)) }
    // Text starts one blank line below the heading.
    v(pitch)
  } else if b.t == "sub" {
    centred(runs(b.runs))
  } else if b.t == "scene" {
    centred(text(b.text))
  } else if b.t == "page" {
    pagebreak(weak: true)
  }
}

// ---- title page -----------------------------------------------------------------------------------

#if data.titlePage != none {
  let tp = data.titlePage
  {
    set par(leading: pt(T.singleLeading), spacing: pt(T.singleLeading))
    grid(
      columns: (1fr, auto),
      column-gutter: 1em,
      tp.contact.map(l => par(text(l))).join(),
      if tp.wordCount != "" { par(text(tp.wordCount)) },
    )
  }
  place(top + center, dy: pt(tp.drop), {
    centred(text(tp.title))
    if tp.byline != "" {
      v(pitch)
      centred(text(tp.byline))
    }
  })
  pagebreak()
}

// ---- the text -------------------------------------------------------------------------------------

#for b in data.blocks { block-of(b) }
#if data.endMarker != "" { centred(text(data.endMarker)) }
