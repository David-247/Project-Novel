import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { effectiveStyleId, getResolvedStyles } from '@/features/editor'
import { blockCheckText, textRangeToDoc } from '@/features/spellcheck'
import { checkPassage, type GuardResult } from './guard'
import type { Location, ParagraphIndex } from './paragraph-index'

/**
 * The tutor's output tools (design, "Tools"): `list_corrections` renders a correction list in the panel,
 * `propose_change` opens the side-by-side view with a "Tutor suggestion". Both put AI text where it could
 * enter the manuscript, so both pass through the guard (guard.ts) first; nothing reaches the panel
 * before it passes. A rejection goes back to the model as `{ rejected: reason, instruction }` and the
 * panel never sees it.
 */

export type CorrectionKind = 'spelling' | 'grammar' | 'punctuation' | 'style' | 'format'
export type CorrectionState = 'open' | 'applied' | 'ignored' | 'changed'

/**
 * One listed correction. `original` is the text in the paragraph (No Markup) and `suggestion` its
 * replacement; `format` corrections are text-level too (spacing, quotes, a scene-break marker): a
 * paragraph style change goes through propose_change. `state` turns 'changed' once the writer edits the
 * paragraph (Review Focus 2): it can then never be applied.
 */
export interface Correction {
  id: string
  paragraphId: string
  location: Location
  kind: CorrectionKind
  original: string
  suggestion: string
  explanation: string
  state: CorrectionState
}

/**
 * A proposed change: one revised text per paragraph, in the same order. `style`, when set, is the id of
 * the paragraph style to give every listed paragraph (a formatting change; the text may then be
 * unchanged).
 */
export interface ProposedChange {
  paragraphIds: string[]
  revisedText: string[]
  reason: string
  style?: string
}

/** What the model is told when the guard (or a check before it) turns its output down. */
export interface Rejection {
  rejected: string
  instruction: string
}

export const EXPLAIN_INSTEAD = 'Explain this in chat instead.'
const REREAD = 'Read the text again with read_range and use the paragraph ids it gives.'

/** The most corrections one list_corrections call may carry, and paragraphs one propose_change. */
export const MAX_CORRECTIONS = 50
export const MAX_PROPOSAL_PARAGRAPHS = 20

/**
 * The corrections of a chat session. `refresh()` marks every open correction whose paragraph was edited
 * (it no longer resolves) as 'changed' and tells the subscribers, with the corrections that changed.
 */
export interface CorrectionBook {
  list(): Correction[]
  get(id: string): Correction | undefined
  add(c: Omit<Correction, 'id' | 'state'>): Correction
  /** The writer applied or ignored it (the panel). Only an open correction moves. */
  setState(id: string, state: 'applied' | 'ignored'): void
  refresh(): Correction[]
  subscribe(listener: (changed: Correction[]) => void): () => void
}

export function createCorrectionBook(idx: ParagraphIndex): CorrectionBook {
  const items = new Map<string, Correction>()
  const listeners = new Set<(changed: Correction[]) => void>()
  let n = 0
  return {
    list: () => [...items.values()],
    get: (id) => items.get(id),
    add(c) {
      const item: Correction = { ...c, id: `c${++n}`, state: 'open' }
      items.set(item.id, item)
      return item
    },
    setState(id, state) {
      const c = items.get(id)
      if (c?.state === 'open') items.set(id, { ...c, state })
    },
    refresh() {
      const changed: Correction[] = []
      for (const c of items.values()) {
        if (c.state !== 'open' || typeof idx.resolve(c.paragraphId) === 'object') continue
        const next: Correction = { ...c, state: 'changed' }
        items.set(c.id, next)
        changed.push(next)
      }
      if (changed.length) for (const l of listeners) l(changed)
      return changed
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

export interface OutputToolsContext {
  idx: ParagraphIndex
  corrections: CorrectionBook
  /** Corrections that passed the guard, to show in the panel. */
  onCorrections(items: Correction[]): void
  /** A change that passed the guard, to open side by side. */
  onProposal(change: ProposedChange): void
}

type Paragraph = { id: string; pos: number; text: string; styleId: string }

/** The paragraph with id `id` as it is now, or why it cannot be used. */
function paragraphOf(idx: ParagraphIndex, id: string): Paragraph | Rejection {
  const at = idx.resolve(id)
  if (at === 'unknown') return { rejected: 'unknown_paragraph', instruction: REREAD }
  if (at === 'changed') return { rejected: 'paragraph_changed', instruction: `The writer has edited ${id} since you read it. ${REREAD}` }
  const node = idx.editor.state.doc.nodeAt(at.from)
  if (!node?.isTextblock) return { rejected: 'unknown_paragraph', instruction: REREAD }
  return { id, pos: at.from, text: blockCheckText(node, at.from).text, styleId: effectiveStyleId(node) }
}

const isRejection = (x: unknown): x is Rejection => typeof x === 'object' && x !== null && 'rejected' in x

const guardRejection = (g: GuardResult): Rejection | null => (g.ok ? null : { rejected: g.reason, instruction: EXPLAIN_INSTEAD })

/** Run `f`; anything it throws (a position outside a textblock, say) is a rejection, never a throw. */
function safely<T>(f: () => T): T | Rejection {
  try {
    return f()
  } catch {
    return { rejected: 'error', instruction: EXPLAIN_INSTEAD }
  }
}

/** A style by id or by name (any case), from the book's styles. */
function findStyle(key: string): string | null {
  const styles = getResolvedStyles()
  if (styles.has(key)) return key
  const lower = key.trim().toLowerCase()
  for (const s of styles.values()) if (s.name.toLowerCase() === lower) return s.id
  return null
}

const correctionSchema = z.object({
  paragraph: z.string().min(1).max(20).describe('The paragraph id ("p12") from read_range, find_text or a check.'),
  kind: z.enum(['spelling', 'grammar', 'punctuation', 'style', 'format']),
  original: z.string().min(1).max(500).describe('The text to correct, quoted exactly as it is in the paragraph (a word or a few).'),
  suggestion: z.string().max(500).describe('What replaces it. A small mechanical fix only.'),
  explanation: z.string().min(1).max(1000).describe('Why, in a sentence or two, teaching the rule.'),
})

const proposalSchema = z.object({
  paragraphIds: z.array(z.string().min(1).max(20)).min(1).max(MAX_PROPOSAL_PARAGRAPHS),
  revisedText: z.array(z.string().max(20_000)).min(1).max(MAX_PROPOSAL_PARAGRAPHS).describe('One revised text per paragraph id, in the same order.'),
  reason: z.string().min(1).max(1000).describe('Why, for the writer.'),
  style: z.string().min(1).max(100).optional().describe('A paragraph style (its name or id) to give these paragraphs. For formatting changes; the text may then be unchanged.'),
})

export function createOutputTools(ctx: OutputToolsContext): ToolSet {
  const { idx } = ctx

  function correction(item: z.infer<typeof correctionSchema>): Correction | Rejection {
    const p = paragraphOf(idx, item.paragraph)
    if (isRejection(p)) return p
    const at = p.text.indexOf(item.original)
    if (at < 0) return { rejected: 'not_found', instruction: `Quote "original" exactly as it is in ${p.id}.` }
    if (item.suggestion === item.original) return { rejected: 'no_change', instruction: EXPLAIN_INSTEAD }
    const revised = p.text.slice(0, at) + item.suggestion + p.text.slice(at + item.original.length)
    // The suggestion is guarded in its paragraph, so the passage is the paragraph, not the snippet.
    const refused = guardRejection(checkPassage([p.text], [revised]))
    if (refused) return refused
    const { segments } = blockCheckText(idx.editor.state.doc.nodeAt(p.pos)!, p.pos)
    const docAt = textRangeToDoc(segments, at, at + item.original.length)
    return ctx.corrections.add({
      paragraphId: p.id,
      location: idx.locationOf(p.id, docAt?.from),
      kind: item.kind,
      original: item.original,
      suggestion: item.suggestion,
      explanation: item.explanation,
    })
  }

  function proposal(input: z.infer<typeof proposalSchema>): ProposedChange | Rejection {
    const { paragraphIds, revisedText } = input
    if (paragraphIds.length !== revisedText.length) return { rejected: 'bad_request', instruction: 'Give one revisedText per paragraph id, in the same order.' }
    if (new Set(paragraphIds).size !== paragraphIds.length) return { rejected: 'bad_request', instruction: 'List each paragraph id once.' }
    const paragraphs: Paragraph[] = []
    for (const id of paragraphIds) {
      const p = paragraphOf(idx, id)
      if (isRejection(p)) return p
      paragraphs.push(p)
    }
    let style: string | undefined
    if (input.style !== undefined) {
      const found = findStyle(input.style)
      if (!found) {
        const names = [...getResolvedStyles().values()].map((s) => s.name).join(', ')
        return { rejected: 'unknown_style', instruction: `Use one of the book's styles: ${names}.` }
      }
      style = found
    }
    const originals = paragraphs.map((p) => p.text)
    const textSame = originals.every((t, i) => t === revisedText[i])
    const restyles = style !== undefined && paragraphs.some((p) => p.styleId !== style)
    if (textSame && !restyles) return { rejected: 'no_change', instruction: EXPLAIN_INSTEAD }
    const refused = guardRejection(checkPassage(originals, revisedText))
    if (refused) return refused
    return { paragraphIds: [...paragraphIds], revisedText: [...revisedText], reason: input.reason, ...(style !== undefined ? { style } : {}) }
  }

  return {
    list_corrections: tool({
      description:
        'Show the writer a list of corrections in the panel, each with Apply and Ignore. Each item is a small mechanical fix ' +
        '(a misspelling, a wrong word, punctuation, at most 3 words in a sentence) to text quoted exactly from a paragraph. ' +
        'Items that are not mechanical are rejected: explain those in chat instead.',
      inputSchema: z.object({ items: z.array(correctionSchema).min(1).max(MAX_CORRECTIONS) }),
      execute: async ({ items }) => {
        const listed: Correction[] = []
        const rejected: (Rejection & { item: number })[] = []
        items.forEach((item, i) => {
          const c = safely(() => correction(item))
          if (isRejection(c)) rejected.push({ item: i, ...c })
          else listed.push(c)
        })
        if (listed.length) ctx.onCorrections(listed)
        return rejected.length ? { listed: listed.map((c) => c.id), rejected } : { listed: listed.map((c) => c.id) }
      },
    }),

    propose_change: tool({
      description:
        'Open a side-by-side view where the writer sees a revised version of whole paragraphs and decides. Mechanical changes only ' +
        '(at most 3 words per sentence, at most 15 % of the passage, no new sentences), or a paragraph style change. ' +
        'Never new prose: anything else is rejected, and you then explain it in chat instead.',
      inputSchema: proposalSchema,
      execute: async (input) => {
        const change = safely(() => proposal(input))
        if (isRejection(change)) return change
        ctx.onProposal(change)
        return { proposed: true, note: 'The writer sees it side by side and decides.' }
      },
    }),
  }
}
