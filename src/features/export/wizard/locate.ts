import type { Node as PMNode } from '@tiptap/pm/model'

/**
 * Where a check's Show me goes in the manuscript (document positions of the live document, read when
 * the wizard opens; the modal wizard keeps the document as it is). The IR counts these things; this
 * finds the first of each in the document, by the same rules.
 */
export interface DocLocations {
  /** The first gap of two or more spaces after a full stop: from the first space to the end of the gap. */
  doubleSpace: { from: number; to: number } | null
  /** The first book formatting the export leaves out: a direct font or size, or a paragraph's own layout. */
  formatting: number | null
}

/** A sentence end (and its closing quotes or brackets), then two or more spaces (as `countDoubleSpaces`). */
const DOUBLE_SPACE = /[.!?]["'”’)\]»]*( {2,})/

/** A paragraph's own layout the manuscript format replaces (as the IR's `strippedFormatting.blockLayout`). */
function hasBlockLayout(node: PMNode): boolean {
  const a = node.attrs as Record<string, unknown>
  return a.lineHeight != null || a.paragraphSpacing != null || a.firstLineIndent != null || (typeof a.indent === 'number' && a.indent > 0)
}

/** A run with a direct font family or size (as the IR's `strippedFormatting.fontFamily` / `fontSize`). */
function hasDirectFont(node: PMNode): boolean {
  return node.marks.some((m) => m.type.name === 'textStyle' && (!!m.attrs.fontFamily || !!m.attrs.fontSize))
}

/**
 * The first double space after a full stop inside one text node (a gap that crosses a change of
 * formatting is not found: the check then says so) and the first stripped formatting.
 */
export function locateInDoc(doc: PMNode): DocLocations {
  let doubleSpace: DocLocations['doubleSpace'] = null
  let formatting: number | null = null
  doc.descendants((node, pos) => {
    if (doubleSpace && formatting !== null) return false
    if (formatting === null && node.isTextblock && hasBlockLayout(node)) formatting = pos + 1
    if (!node.isText) return true
    if (formatting === null && hasDirectFont(node)) formatting = pos
    if (!doubleSpace) {
      const m = DOUBLE_SPACE.exec(node.text ?? '')
      if (m) {
        const from = pos + m.index + m[0].length - m[1].length
        doubleSpace = { from, to: from + m[1].length }
      }
    }
    return false
  })
  return { doubleSpace, formatting }
}
