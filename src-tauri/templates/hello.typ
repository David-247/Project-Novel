// Hello-world template: the smoke test for the Typst sidecar (bundled font, data file, offline).
// Every export template reads its data from data.json and its font from sys.inputs:
//   font           the chosen family (an installed Times New Roman / Courier New, or the bundled one)
//   font-fallback  the bundled metric-compatible family (Liberation Serif / Liberation Mono)
// Templates must not import packages or eval text (export is fully offline; see export/templates.rs).
#let data = json("data.json")
#set document(title: data.title)
#set page(paper: "us-letter", margin: 1in)
#set text(font: (sys.inputs.at("font"), sys.inputs.at("font-fallback")), size: 12pt)

= #data.title

#data.body

_Italic_ and *bold* text.
