import { Extension } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import type { Transaction } from '@tiptap/pm/state'
import { INDENT_STEP_EM, MAX_INDENT } from './presets'

/** Block nodes that carry spacing/indent attributes. */
export const BLOCK_FORMAT_TYPES = ['paragraph', 'heading'] as const

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    blockFormat: {
      /** Line height of the selected paragraphs/headings (e.g. `'1.5'`); `null` unsets. */
      setBlockLineHeight: (value: string | null) => ReturnType
      /** Space after the selected paragraphs/headings (CSS length, e.g. `'1em'`); `null` unsets. */
      setBlockSpacing: (value: string | null) => ReturnType
      /** First-line indent of the selected paragraphs/headings (CSS length, e.g. `'0.5in'`); `null` unsets. */
      setFirstLineIndent: (value: string | null) => ReturnType
      /** Indent: sinks the list item when inside a list, otherwise raises the block indent level. */
      indentBlock: () => ReturnType
      /** Outdent: lifts the list item when inside a list, otherwise lowers the block indent level. */
      outdentBlock: () => ReturnType
    }
  }
}

const SAFE_CSS_VALUE = /^[0-9a-z.%]+$/i

function cssValue(v: unknown): string | null {
  return typeof v === 'string' && v !== '' && SAFE_CSS_VALUE.test(v) ? v : null
}

function clampIndent(n: unknown): number {
  const v = typeof n === 'number' ? n : parseInt(String(n ?? 0), 10)
  return Number.isFinite(v) ? Math.max(0, Math.min(MAX_INDENT, Math.trunc(v))) : 0
}

/** True when the selection head sits inside a list item (O(depth)). */
export function inListItem(tr: Pick<Transaction, 'selection'>): boolean {
  const { $from } = tr.selection
  for (let d = $from.depth; d > 0; d--) if ($from.node(d).type.name === 'listItem') return true
  return false
}

/**
 * Applies `fn` to each paragraph/heading touched by the selection. Work is bounded by the
 * selection size (never the whole doc). Returns true when at least one block was applicable.
 */
function updateBlocks(
  tr: Transaction,
  dispatch: unknown,
  fn: (node: PMNode) => Record<string, unknown> | null,
): boolean {
  let applicable = false
  for (const { $from, $to } of tr.selection.ranges) {
    tr.doc.nodesBetween($from.pos, $to.pos, (node, pos) => {
      if (!(BLOCK_FORMAT_TYPES as readonly string[]).includes(node.type.name)) return true
      const attrs = fn(node)
      if (attrs) {
        applicable = true
        if (dispatch) tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs })
      }
      return false
    })
  }
  return applicable
}

/**
 * Paragraph/heading layout attributes, rendered as inline style:
 * - `lineHeight` -> `line-height`
 * - `paragraphSpacing` -> `margin-bottom` (space after)
 * - `firstLineIndent` -> `text-indent`
 * - `indent` (0..MAX_INDENT) -> `margin-left: indent * INDENT_STEP_EM em` (+ `data-indent`)
 * Shortcuts: Mod-] indent, Mod-[ outdent.
 */
export const BlockFormat = Extension.create({
  name: 'blockFormat',

  addGlobalAttributes() {
    return [
      {
        types: [...BLOCK_FORMAT_TYPES],
        attributes: {
          lineHeight: {
            default: null,
            parseHTML: (el) => cssValue(el.style.lineHeight),
            renderHTML: (attrs) => {
              const v = cssValue(attrs.lineHeight)
              return v ? { style: `line-height: ${v}` } : {}
            },
          },
          paragraphSpacing: {
            default: null,
            parseHTML: (el) => cssValue(el.style.marginBottom),
            renderHTML: (attrs) => {
              const v = cssValue(attrs.paragraphSpacing)
              return v ? { style: `margin-bottom: ${v}` } : {}
            },
          },
          firstLineIndent: {
            default: null,
            parseHTML: (el) => cssValue(el.style.textIndent),
            renderHTML: (attrs) => {
              const v = cssValue(attrs.firstLineIndent)
              return v ? { style: `text-indent: ${v}` } : {}
            },
          },
          indent: {
            default: 0,
            parseHTML: (el) => clampIndent(el.getAttribute('data-indent')),
            renderHTML: (attrs) => {
              const n = clampIndent(attrs.indent)
              return n > 0 ? { 'data-indent': String(n), style: `margin-left: ${n * INDENT_STEP_EM}em` } : {}
            },
          },
        },
      },
    ]
  },

  addCommands() {
    return {
      setBlockLineHeight:
        (value) =>
        ({ tr, dispatch }) =>
          updateBlocks(tr, dispatch, () => ({ lineHeight: cssValue(value) })),
      setBlockSpacing:
        (value) =>
        ({ tr, dispatch }) =>
          updateBlocks(tr, dispatch, () => ({ paragraphSpacing: cssValue(value) })),
      setFirstLineIndent:
        (value) =>
        ({ tr, dispatch }) =>
          updateBlocks(tr, dispatch, () => ({ firstLineIndent: cssValue(value) })),
      indentBlock:
        () =>
        ({ tr, dispatch, commands }) => {
          if (inListItem(tr)) return commands.sinkListItem('listItem')
          return updateBlocks(tr, dispatch, (node) => {
            const n = clampIndent(node.attrs.indent)
            return n < MAX_INDENT ? { indent: n + 1 } : null
          })
        },
      outdentBlock:
        () =>
        ({ tr, dispatch, commands }) => {
          if (inListItem(tr)) return commands.liftListItem('listItem')
          return updateBlocks(tr, dispatch, (node) => {
            const n = clampIndent(node.attrs.indent)
            return n > 0 ? { indent: n - 1 } : null
          })
        },
    }
  },

  addKeyboardShortcuts() {
    return {
      'Mod-]': () => this.editor.commands.indentBlock(),
      'Mod-[': () => this.editor.commands.outdentBlock(),
    }
  },
})
