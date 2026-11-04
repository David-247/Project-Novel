import { Extension } from '@tiptap/core'
import { closeHistory } from '@tiptap/pm/history'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import type { EditorState, Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import {
  chapterRoleSignature,
  continuesHeadingGroup,
  DEFAULT_STYLE_ID,
  STYLE_ID_PATTERN,
  STYLE_IDS,
  type ResolvedStyle,
  type ResolvedStyles,
} from '@/shared/book'
import { useStore } from '@/shared/store'
import { inListItem } from '../toolbar/block-format'
import { getResolvedStyles, resolveStyles } from './resolved'

/** Block nodes that carry a paragraph/chapter style. */
export const STYLED_BLOCK_TYPES = ['paragraph', 'heading'] as const

/** Direct block formatting (Phase 1 toolbar) and the value that means "use the style". */
export const DIRECT_BLOCK_ATTRS = { textAlign: null, lineHeight: null, paragraphSpacing: null, firstLineIndent: null, indent: 0 } as const

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    blockStyles: {
      /** Applies a paragraph or chapter style to every paragraph/heading touched by the selection (one undo step). */
      setBlockStyle: (styleId: string) => ReturnType
      /** Resets the selected blocks to their style: removes alignment, spacing, indent attributes and text marks. */
      clearDirectFormatting: () => ReturnType
    }
  }
}

const isStyledType = (node: PMNode) => (STYLED_BLOCK_TYPES as readonly string[]).includes(node.type.name)

function validId(v: unknown): string | null {
  return typeof v === 'string' && STYLE_ID_PATTERN.test(v) ? v : null
}

/**
 * Phase 1 migration rule (rendering mapping, the document is never rewritten on load): a block
 * without a `styleId` uses Body when it is a paragraph, Chapter Title when it is a level-1 heading
 * and Subheading when it is a level-2 or level-3 heading. A Phase 1 manuscript.json therefore loads
 * unchanged and saves unchanged until the user applies a style.
 */
export function defaultStyleIdFor(attrs: Record<string, unknown>, typeName?: string): string {
  const level = attrs.level
  if (typeName === 'paragraph' || level === undefined) return DEFAULT_STYLE_ID
  return level === 1 ? STYLE_IDS.chapterTitle : STYLE_IDS.subheading
}

/** The style a paragraph/heading renders with (its `styleId`, or the migration default). */
export function effectiveStyleId(node: PMNode): string {
  return validId(node.attrs.styleId) ?? defaultStyleIdFor(node.attrs, node.type.name)
}

/**
 * Restyles the block at `pos` in `tr`: converts paragraph <-> heading to match the style's kind
 * (chapter styles are headings at `outlineLevel`), stores the style id (Body on a paragraph is
 * stored as null) and optionally drops direct block formatting. Returns false when the block cannot
 * take the style here (a chapter style inside a list item).
 */
export function restyleBlock(tr: Transaction, pos: number, style: ResolvedStyle, clearDirect = false): boolean {
  const node = tr.doc.nodeAt(pos)
  if (!node || !isStyledType(node)) return false
  const schema = tr.doc.type.schema
  const heading = style.kind === 'chapter'
  const type = heading ? schema.nodes.heading : schema.nodes.paragraph
  if (type !== node.type) {
    const $pos = tr.doc.resolve(pos)
    if (!$pos.parent.canReplaceWith($pos.index(), $pos.index() + 1, type)) return false
  }
  const attrs: Record<string, unknown> = { ...node.attrs, ...(clearDirect ? DIRECT_BLOCK_ATTRS : {}) }
  attrs.styleId = !heading && style.id === DEFAULT_STYLE_ID ? null : style.id
  if (heading) attrs.level = style.outlineLevel ?? 1
  else delete attrs.level
  const same = type === node.type && Object.keys({ ...node.attrs, ...attrs }).every((k) => (attrs[k] ?? null) === (node.attrs[k] ?? null))
  if (!same) tr.setNodeMarkup(pos, type, attrs)
  return true
}

/** Every styled block touched by the selection; work bounded by the selection, never the doc. */
function forSelectedBlocks(tr: Transaction, fn: (node: PMNode, pos: number) => boolean): boolean {
  let any = false
  const seen = new Set<number>()
  for (const { $from, $to } of tr.selection.ranges) {
    tr.doc.nodesBetween($from.pos, $to.pos, (node, pos) => {
      if (!isStyledType(node)) return true
      if (!seen.has(pos)) {
        seen.add(pos)
        if (fn(node, pos)) any = true
      }
      return false
    })
  }
  return any
}

/**
 * Restyles every block whose effective style is `fromId` to `to` in one transaction (O(document);
 * used when a style is deleted). Returns the number of blocks changed.
 */
export function remapStyleInDoc(tr: Transaction, fromId: string, to: ResolvedStyle): number {
  const positions: number[] = []
  tr.doc.descendants((node, pos) => {
    if (!isStyledType(node)) return true
    if (validId(node.attrs.styleId) === fromId || effectiveStyleId(node) === fromId) positions.push(pos)
    return false
  })
  for (const pos of positions) {
    if (!restyleBlock(tr, pos, to)) {
      const node = tr.doc.nodeAt(pos)!
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, styleId: null })
    }
  }
  return positions.length
}

/** Number of blocks whose effective style is `id` (O(document); for delete confirmations). */
export function countBlocksWithStyle(doc: PMNode, id: string): number {
  let n = 0
  doc.descendants((node) => {
    if (!isStyledType(node)) return true
    if (effectiveStyleId(node) === id) n++
    return false
  })
  return n
}

// ---- breakBefore exposure for pagination ------------------------------------------------------

interface BreakState {
  decorations: DecorationSet
  /** Break-relevant shape of the style sheet; a style edit that does not change it dispatches nothing. */
  signature: string
}

export const styleBreaksKey = new PluginKey<BreakState>('nvStyleBreaks')

/** The set of defined style ids (which ids render as themselves, see `renderedStyleId`). */
function idsSignature(styles: ResolvedStyles): string {
  return [...styles.keys()].join('|')
}

function breakSignature(styles: ResolvedStyles): string {
  let sig = ''
  for (const s of styles.values()) {
    if ((s.breakBefore && s.breakBefore !== 'none') || s.nextStyle) sig += `${s.id}:${s.breakBefore ?? ''}:${s.nextStyle ?? ''}|`
  }
  // Which ids are defined also decides breaks (an undefined id renders as its fallback), and so do
  // chapter roles (a chapter number then a chapter title break once: continuesHeadingGroup).
  return `${sig}#${idsSignature(styles)}#${chapterRoleSignature(styles)}`
}

/**
 * The style a block is rendered and paginated with: its `styleId` when that names a defined style,
 * otherwise the migration default for its type (Body for a paragraph, Chapter Title for H1,
 * Subheading for H2/H3). A dangling id (style deleted, then brought back by undo/redo; pasted; an
 * out-of-sync book.json) stays in the document unchanged and renders like the fallback.
 */
export function renderedStyleId(node: PMNode, styles: ResolvedStyles): string {
  const id = effectiveStyleId(node)
  return styles.has(id) ? id : defaultStyleIdFor(node.attrs, node.type.name)
}

/**
 * Node decorations `data-break-before="page|recto"` on top-level blocks whose style breaks (the
 * pagination contract). A block continuing a heading group (e.g. Chapter Title right after Chapter
 * Number) does not break again. O(top-level blocks).
 */
function computeBreaks(doc: PMNode, styles: ResolvedStyles): DecorationSet {
  const decos: Decoration[] = []
  let prev: string | null = null
  let afterPageBreak = false
  doc.forEach((node, offset) => {
    if (node.type.name === 'pageBreak') {
      // A manual page break makes the block after it start a page (recto, when its style says so).
      afterPageBreak = true
      prev = null
      return
    }
    const id = isStyledType(node) ? renderedStyleId(node, styles) : null
    const b = id ? styles.get(id)?.breakBefore : undefined
    let value: 'page' | 'recto' | undefined =
      id && (b === 'page' || b === 'recto') && !continuesHeadingGroup(prev, id, styles) ? b : undefined
    if (afterPageBreak && value !== 'recto') value = 'page'
    if (value) decos.push(Decoration.node(offset, offset + node.nodeSize, { 'data-break-before': value }))
    afterPageBreak = false
    prev = id
  })
  return DecorationSet.create(doc, decos)
}

/** True when both docs have the same top-level block types and attrs (typing inside a block). */
function sameTopLevelShape(a: PMNode, b: PMNode): boolean {
  if (a.childCount !== b.childCount) return false
  for (let i = 0; i < a.childCount; i++) {
    const x = a.child(i)
    const y = b.child(i)
    if (x !== y && (x.type !== y.type || x.attrs !== y.attrs)) return false
  }
  return true
}

const STYLES_META = 'nvStylesChanged'

function breaksPlugin(): Plugin<BreakState> {
  return new Plugin<BreakState>({
    key: styleBreaksKey,
    state: {
      init: (_, state) => {
        const styles = getResolvedStyles()
        return { decorations: computeBreaks(state.doc, styles), signature: breakSignature(styles) }
      },
      apply: (tr, value, oldState, newState) => {
        const meta = tr.getMeta(STYLES_META) as ResolvedStyles | undefined
        if (meta) return { decorations: computeBreaks(newState.doc, meta), signature: breakSignature(meta) }
        if (!tr.docChanged) return value
        if (sameTopLevelShape(oldState.doc, newState.doc)) {
          return { ...value, decorations: value.decorations.map(tr.mapping, tr.doc) }
        }
        return { ...value, decorations: computeBreaks(newState.doc, getResolvedStyles()) }
      },
    },
    props: {
      decorations: (state: EditorState) => styleBreaksKey.getState(state)?.decorations,
    },
    // Keep data-break-before in step with style edits. Only a change to the break-relevant shape of
    // the sheet dispatches (a decoration-only transaction: no document change, no undo step).
    view: (view) => ({
      destroy: useStore.subscribe((s, prev) => {
        if (s.book.styles === prev.book.styles || view.isDestroyed) return
        const styles = resolveStyles(s.book.styles)
        if (styleBreaksKey.getState(view.state)?.signature === breakSignature(styles)) return
        view.dispatch(view.state.tr.setMeta(STYLES_META, styles).setMeta('addToHistory', false))
      }),
    }),
  })
}

// ---- data-style: the rendered (resolved) style id --------------------------------------------

interface StyleIdState {
  decorations: DecorationSet
  /** Defined ids the decorations were computed for. */
  signature: string
}

export const styleIdsKey = new PluginKey<StyleIdState>('nvStyleIds')

/** Above this many steps a transaction recomputes all data-style decorations instead. */
const INCREMENTAL_MAX_STEPS = 16

function styleIdDeco(node: PMNode, pos: number, styles: ResolvedStyles): Decoration {
  return Decoration.node(pos, pos + node.nodeSize, { 'data-style': renderedStyleId(node, styles) })
}

function computeStyleIds(doc: PMNode, styles: ResolvedStyles): DecorationSet {
  const decos: Decoration[] = []
  doc.descendants((node, pos) => {
    if (!isStyledType(node)) return true
    decos.push(styleIdDeco(node, pos, styles))
    return false
  })
  return DecorationSet.create(doc, decos)
}

/**
 * Every paragraph/heading carries a node decoration `data-style="<renderedStyleId>"`, overriding the
 * attribute renderHTML writes (which stays the raw id, for the clipboard). Every block has one, so a
 * decoration is only ever changed, never removed, while its block exists (removing one would also
 * remove the attribute). Recomputed in full only when the set of defined ids changes; a document
 * change re-derives just the blocks it touched.
 */
function styleIdsPlugin(): Plugin<StyleIdState> {
  return new Plugin<StyleIdState>({
    key: styleIdsKey,
    state: {
      init: (_, state) => {
        const styles = getResolvedStyles()
        return { decorations: computeStyleIds(state.doc, styles), signature: idsSignature(styles) }
      },
      apply: (tr, value) => {
        const meta = tr.getMeta(STYLES_META) as ResolvedStyles | undefined
        if (meta) {
          const signature = idsSignature(meta)
          return signature === value.signature ? value : { decorations: computeStyleIds(tr.doc, meta), signature }
        }
        if (!tr.docChanged) return value
        const styles = getResolvedStyles()
        // Mapping each step's range through the later steps is O(steps^2): for a big transaction
        // (Replace All: thousands of steps) one O(blocks) recompute is far cheaper.
        if (tr.steps.length > INCREMENTAL_MAX_STEPS) return { ...value, decorations: computeStyleIds(tr.doc, styles) }
        let set = value.decorations.map(tr.mapping, tr.doc)
        const size = tr.doc.content.size
        tr.mapping.maps.forEach((map, i) => {
          const rest = tr.mapping.slice(i + 1)
          map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
            const from = Math.max(0, rest.map(newStart, -1))
            const to = Math.min(size, rest.map(newEnd, 1))
            // Re-derive the styled blocks the change overlaps: drop every decoration overlapping each
            // (after a join or split a mapped one may cover only part of it; mapping may also have
            // dropped it) and add a fresh one. Untouched neighbours keep theirs (they only touch);
            // deleted blocks lost theirs in the mapping.
            const stale: Decoration[] = []
            const fresh: Decoration[] = []
            tr.doc.nodesBetween(from, to, (node, pos) => {
              if (!isStyledType(node)) return true
              const end = pos + node.nodeSize
              for (const d of set.find(pos, end)) if (d.from < end && d.to > pos) stale.push(d)
              fresh.push(styleIdDeco(node, pos, styles))
              return false
            })
            if (fresh.length) set = set.remove(stale).add(tr.doc, fresh)
          })
        })
        return { ...value, decorations: set }
      },
    },
    props: {
      decorations: (state: EditorState) => styleIdsKey.getState(state)?.decorations,
    },
  })
}

/**
 * Paragraph and chapter styles on blocks.
 * - `styleId` attribute on paragraph/heading (default null = migration default, see
 *   `defaultStyleIdFor`). Blocks show `data-style="<renderedStyleId>"` (a node decoration: the id
 *   if defined, else the fallback); the generated stylesheet (`BookStyleSheet`, one rule per defined
 *   style) styles blocks by it, so editing a style never changes the document.
 * - `data-break-before` node decorations for pagination (see `computeBreaks`).
 * - Commands `setBlockStyle`, `clearDirectFormatting`; Enter chaining (`nextStyle`).
 * - Shortcuts: Mod-Alt-0 Body, Mod-Alt-1 Chapter Title (replacing Tiptap's paragraph / H1
 *   shortcuts), Mod-\ clear direct formatting.
 */
export const BlockStyles = Extension.create({
  name: 'blockStyles',
  // Above Paragraph (1000) and Heading for Mod-Alt-0/1, and the core keymap for Enter; lists keep
  // their Enter because the handler steps aside inside list items.
  priority: 1100,

  addGlobalAttributes() {
    return [
      {
        types: [...STYLED_BLOCK_TYPES],
        attributes: {
          styleId: {
            default: null,
            parseHTML: (el) => {
              const id = validId(el.getAttribute('data-style'))
              return id === DEFAULT_STYLE_ID && el.tagName === 'P' ? null : id
            },
            renderHTML: (attrs) => ({ 'data-style': validId(attrs.styleId) ?? defaultStyleIdFor(attrs) }),
          },
        },
      },
    ]
  },

  addCommands() {
    return {
      setBlockStyle:
        (styleId) =>
        ({ tr, dispatch }) => {
          const style = getResolvedStyles().get(styleId)
          if (!style) return false
          // Its own undo step, never merged into the typing just before it.
          if (dispatch) closeHistory(tr)
          return forSelectedBlocks(tr, (_node, pos) => (dispatch ? restyleBlock(tr, pos, style) : canTake(tr, pos, style)))
        },
      clearDirectFormatting:
        () =>
        ({ tr, dispatch }) => {
          // Its own undo step. Block attributes are reset on every touched block; text marks are
          // removed from the selection when there is one (as in Word), else from the whole block.
          if (dispatch) closeHistory(tr)
          const ranges = tr.selection.empty ? null : tr.selection.ranges.map((r) => [r.$from.pos, r.$to.pos] as const)
          const applicable = forSelectedBlocks(tr, (node, pos) => {
            if (dispatch) {
              tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...DIRECT_BLOCK_ATTRS })
              if (!ranges) tr.removeMark(pos + 1, pos + node.nodeSize - 1)
            }
            return true
          })
          // setNodeMarkup keeps positions, so the selection ranges are still valid here.
          if (dispatch && ranges) for (const [from, to] of ranges) tr.removeMark(from, to)
          return applicable
        },
    }
  },

  addKeyboardShortcuts() {
    return {
      'Mod-Alt-0': () => this.editor.commands.setBlockStyle(STYLE_IDS.body),
      'Mod-Alt-1': () => this.editor.commands.setBlockStyle(STYLE_IDS.chapterTitle),
      'Mod-\\': () => this.editor.commands.clearDirectFormatting(),
      Enter: () => {
        // Enter at the end of a block starts the style's next style (Chapter Title -> First
        // Paragraph -> Body). Elsewhere, and in lists, the default Enter runs (the style is kept).
        const { state } = this.editor
        const sel = state.selection
        if (!(sel instanceof TextSelection) || !sel.empty || inListItem(state)) return false
        const { $from } = sel
        const block = $from.parent
        if (!isStyledType(block) || $from.parentOffset !== block.content.size) return false
        const styles = getResolvedStyles()
        const cur = effectiveStyleId(block)
        const target = styles.get(styles.get(cur)?.nextStyle ?? cur) ?? styles.get(DEFAULT_STYLE_ID)
        if (!target) return false
        return this.editor
          .chain()
          .splitBlock()
          .command(({ tr }) => {
            const pos = tr.selection.$from.before()
            if (!restyleBlock(tr, pos, target, target.id !== cur)) restyleBlock(tr, pos, styles.get(DEFAULT_STYLE_ID)!, true)
            return true
          })
          .run()
      },
    }
  },

  addProseMirrorPlugins() {
    return [styleIdsPlugin(), breaksPlugin()]
  },
})

function canTake(tr: Transaction, pos: number, style: ResolvedStyle): boolean {
  const node = tr.doc.nodeAt(pos)!
  const type = style.kind === 'chapter' ? tr.doc.type.schema.nodes.heading : tr.doc.type.schema.nodes.paragraph
  if (type === node.type) return true
  const $pos = tr.doc.resolve(pos)
  return $pos.parent.canReplaceWith($pos.index(), $pos.index() + 1, type)
}
