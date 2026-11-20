import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { chapterIndexAt, getChapters } from '@/features/editor'
import { blockCheckText, checkBlocks, hashText, textRangeToDoc, type Finding } from '@/features/spellcheck'
import { useStore } from '@/shared/store'
import { isScriptName, SCRIPT_NAMES, scriptText, type ScriptName } from './assemble'
import { attachmentLabel, attachmentRange, formatParagraphs, paragraphsIn, type Attachment, type ParagraphText } from './attachments'
import type { Location, ParagraphIndex } from './paragraph-index'

/**
 * What the tools may read without asking (design, Settled point 8): the attachments, or the current
 * chapter when there are none. Anything else waits for the writer's in-chat Allow (`requestRead`).
 */
export interface ReadScope {
  attachments: readonly Attachment[]
}

export interface ReadToolsContext {
  idx: ParagraphIndex
  scope: ReadScope
  /** Ask the writer ("The tutor wants to read Chapter 5. Allow?"); true on Allow. */
  requestRead(target: string): Promise<boolean>
  /** The model chose a script (`use_script`); the harness appends it to the system prompt. */
  onScript?(name: ScriptName): void
}

/** The most a single read_range returns; past it the text is cut and `truncated` set. */
export const READ_WORD_LIMIT = 20_000
/** The most findings or matches one call returns. */
export const MAX_RESULTS = 200
export const MAX_MATCHES = 50

type Range = { from: number; to: number }
type Target = { kind: 'attached' | 'page' | 'chapter' | 'selection' | 'manuscript'; number?: number }

const targetSchema = {
  kind: z
    .enum(['attached', 'page', 'chapter', 'selection', 'manuscript'])
    .default('attached')
    .describe('What to work on: "attached" (what the writer attached, or the current chapter), a page, a chapter, the selection, or the whole manuscript.'),
  number: z.number().int().positive().optional().describe('The page or chapter number as the writer sees it (from 1). Leave out for the current one.'),
}

/** The merged ranges cover all of `r`. */
function covered(r: Range, ranges: readonly Range[]): boolean {
  const sorted = [...ranges].sort((a, b) => a.from - b.from)
  let start = -1
  let end = -1
  for (const x of sorted) {
    if (x.from > end) {
      if (start >= 0 && r.from >= start && r.to <= end) return true
      start = x.from
      end = x.to
    } else end = Math.max(end, x.to)
  }
  return start >= 0 && r.from >= start && r.to <= end
}

/** A snippet for a match: its sentence, cut to about 200 characters around the match. */
function sentenceAround(text: string, start: number, end: number): string {
  let a = start
  while (a > 0 && !/[.!?…]["'”’)\]]*\s$/.test(text.slice(Math.max(0, a - 4), a))) a--
  const after = /[.!?…]["'”’)\]]*(\s|$)/g
  after.lastIndex = end
  const m = after.exec(text)
  let b = m ? m.index + m[0].trimEnd().length : text.length
  if (start - a > 100) a = start - 100
  if (b - end > 100) b = end + 100
  return text.slice(a, b).replace(/\s+/g, ' ').trim()
}

/**
 * The model-callable read tools (design, "Tools"): read_range, find_text, check_spelling,
 * check_grammar and use_script. They read the mounted manuscript through the paragraph index, as No
 * Markup shows it, and never take file paths. Locations are the writer's (`Location`).
 */
export function createReadTools(ctx: ReadToolsContext): ToolSet {
  const { idx } = ctx
  const doc = () => idx.editor.state.doc
  /** Reads the writer allowed in this chat, beyond the scope. */
  const granted: Attachment[] = []

  function currentChapterIndex(): number {
    const { pages, currentPage } = useStore.getState().layout
    const page = pages[currentPage]
    if (page) return page.chapterIndex
    return chapterIndexAt(getChapters(doc()), idx.editor.state.selection.head)
  }

  /** The current chapter's range (the front matter before the first chapter). */
  function currentChapterRange(): Range {
    const chapters = getChapters(doc())
    const i = currentChapterIndex()
    const c = chapters[i]
    return c ? { from: c.from, to: c.to } : { from: 0, to: chapters[0]?.from ?? doc().content.size }
  }

  /** The ranges in scope now (attachments re-resolved against the document as it is). */
  function scopeRanges(): Range[] {
    const d = doc()
    const listed = ctx.scope.attachments.flatMap((a) => attachmentRange(a, d) ?? [])
    const base = ctx.scope.attachments.length ? listed : [currentChapterRange()]
    return [...base, ...granted.flatMap((a) => attachmentRange(a, d) ?? [])]
  }

  const chapterCount = () => getChapters(doc()).length

  /** A target to an attachment and its label, or an error for the model. */
  function resolve(t: Target): { attachment: Attachment; label: string; range: Range } | { error: string } {
    const d = doc()
    let attachment: Attachment
    switch (t.kind) {
      case 'page': {
        const count = useStore.getState().layout.pages.length
        const page = t.number ?? useStore.getState().layout.currentPage + 1
        if (count === 0) return { error: 'The book is not laid out in pages yet. Read a chapter instead.' }
        if (page > count) return { error: `There is no page ${page}. The book has ${count} pages.` }
        attachment = { kind: 'page', page }
        break
      }
      case 'chapter': {
        const count = chapterCount()
        if (t.number === undefined) {
          const i = currentChapterIndex()
          if (i < 0) return { error: 'The caret is in the front matter, before the first chapter. Name a chapter number.' }
          attachment = { kind: 'chapter', chapter: i + 1 }
        } else if (t.number > count) return { error: `There is no chapter ${t.number}. The book has ${count} chapters.` }
        else attachment = { kind: 'chapter', chapter: t.number }
        break
      }
      case 'selection': {
        const { from, to } = idx.editor.state.selection
        if (from === to) return { error: 'Nothing is selected in the manuscript.' }
        attachment = { kind: 'selection', from, to }
        break
      }
      case 'manuscript':
        attachment = { kind: 'manuscript' }
        break
      case 'attached':
        return { error: 'internal: attached has no single range' }
    }
    const range = attachmentRange(attachment, d)
    if (!range) return { error: `Could not find ${attachmentLabel(attachment)}.` }
    return { attachment, label: attachmentLabel(attachment, d), range }
  }

  /**
   * The ranges a target covers, after asking the writer when it lies outside the scope. `denied` when
   * they said no; `clip` when the text is cut to the range (a selection).
   */
  async function rangesFor(input: Partial<Target>): Promise<{ label: string; ranges: Range[]; clip: boolean } | { denied: true } | { error: string }> {
    // The SDK fills the schema's default; a direct call may leave it out.
    const t: Target = { kind: input.kind ?? 'attached', number: input.number }
    if (t.kind === 'attached') {
      const label = ctx.scope.attachments.length ? 'Attached' : 'Current chapter'
      return { label, ranges: scopeRanges(), clip: ctx.scope.attachments.some((a) => a.kind === 'selection') }
    }
    const r = resolve(t)
    if ('error' in r) return r
    if (!covered(r.range, scopeRanges())) {
      const allowed = await ctx.requestRead(r.label)
      if (!allowed) return { denied: true }
      granted.push(r.attachment)
    }
    return { label: r.label, ranges: [r.range], clip: r.attachment.kind === 'selection' }
  }

  /** Paragraphs of the ranges, each once, in document order. */
  function paragraphsOf(ranges: readonly Range[], clip: boolean): (ParagraphText | null)[] {
    const seen = new Set<string>()
    const out: (ParagraphText | null)[] = []
    for (const r of [...ranges].sort((a, b) => a.from - b.from))
      for (const p of paragraphsIn(idx, r.from, r.to, clip)) {
        if (p && seen.has(p.id)) continue
        if (p) seen.add(p.id)
        out.push(p)
      }
    return out
  }

  async function check(kind: Finding['kind'], t: Partial<Target>) {
    const got = await rangesFor(t)
    if (!('ranges' in got)) return got
    // Whole paragraphs go to the engine (offsets are the paragraph's); findings outside the ranges drop.
    const paragraphs = paragraphsOf(got.ranges, false).filter((p): p is ParagraphText => p !== null)
    const blocks = paragraphs.map((p) => ({ p, check: blockCheckText(p.node, p.pos) }))
    let found: Map<string, Finding[]>
    try {
      found = await checkBlocks(blocks.map((b) => ({ id: hashText(b.check.text), text: b.check.text })))
    } catch {
      return { error: 'The spelling and grammar checker could not run.' }
    }
    const findings: { paragraph: string; location: Location; text: string; kind: Finding['kind']; rule: string; message: string; suggestions: string[] }[] = []
    let more = 0
    for (const { p, check: c } of blocks)
      for (const f of found.get(hashText(c.text)) ?? []) {
        if (f.kind !== kind) continue
        const at = textRangeToDoc(c.segments, f.start, f.end)
        if (!at || !got.ranges.some((r) => at.from < r.to && at.to > r.from)) continue
        if (findings.length >= MAX_RESULTS) {
          more++
          continue
        }
        findings.push({ paragraph: p.id, location: idx.locationOf(p.id, at.from), text: c.text.slice(f.start, f.end), kind: f.kind, rule: f.rule, message: f.message, suggestions: f.suggestions })
      }
    return more ? { source: got.label, findings, truncated: more } : { source: got.label, findings }
  }

  return {
    read_range: tool({
      description:
        'Read part of the manuscript as plain text, one "[pN] text" line per paragraph (footnotes after their paragraph). ' +
        'kind "outline" lists the chapters with their word counts instead. Reading outside what the writer attached ' +
        '(or the current chapter) asks the writer first; { denied: true } means they said no.',
      inputSchema: z.object({
        ...targetSchema,
        kind: z.enum(['attached', 'page', 'chapter', 'selection', 'manuscript', 'outline']).default('attached').describe(targetSchema.kind.description ?? ''),
      }),
      execute: async (input) => {
        if (input.kind === 'outline') {
          const counts = useStore.getState().wordCount.chapters
          return {
            chapters: getChapters(doc()).map((c) => ({
              chapter: c.index + 1,
              title: c.title.replace(/\s+/g, ' ').trim(),
              words: counts.find((w) => w.index === c.index && w.from === c.from)?.counts.total.words ?? null,
            })),
          }
        }
        const got = await rangesFor(input as Partial<Target>)
        if (!('ranges' in got)) return got
        const paragraphs = paragraphsOf(got.ranges, got.clip)
        const all = formatParagraphs(paragraphs)
        if (all.words <= READ_WORD_LIMIT) return { source: got.label, text: all.text, words: all.words }
        // Too long for one read: cut at a paragraph.
        let words = 0
        let n = 0
        for (; n < paragraphs.length; n++) {
          const w = formatParagraphs([paragraphs[n]]).words
          if (words + w > READ_WORD_LIMIT) break
          words += w
        }
        const cut = formatParagraphs(paragraphs.slice(0, n))
        return { source: got.label, text: cut.text, words: cut.words, truncated: true, totalWords: all.words, note: 'The text was cut. Read one chapter at a time.' }
      },
    }),

    find_text: tool({
      description:
        'Find text in the manuscript (case-insensitive). Returns the matches within what you may read, each with its paragraph id, location and sentence; ' +
        'matches elsewhere are only counted (outsideScope).',
      inputSchema: z.object({ query: z.string().min(1).max(200).describe('The text to find.') }),
      execute: async ({ query }) => {
        const needle = query.toLocaleLowerCase()
        const ranges = scopeRanges()
        const matches: { paragraph: string; location: Location; snippet: string }[] = []
        let outsideScope = 0
        let more = 0
        doc().descendants((node, pos) => {
          if (!node.isTextblock) return true
          const c = blockCheckText(node, pos)
          const hay = c.text.toLocaleLowerCase()
          for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) {
            const at = textRangeToDoc(c.segments, i, i + needle.length)
            if (!at) continue
            if (!covered(at, ranges)) {
              outsideScope++
              continue
            }
            if (matches.length >= MAX_MATCHES) {
              more++
              continue
            }
            const id = idx.idFor(pos)
            matches.push({ paragraph: id, location: idx.locationOf(id, at.from), snippet: sentenceAround(c.text, i, i + needle.length) })
          }
          return false
        })
        return more ? { matches, outsideScope, truncated: more } : { matches, outsideScope }
      },
    }),

    check_spelling: tool({
      description: 'Check spelling (the offline Harper checker, with the writer\'s dictionary). Returns each finding with its paragraph id, location, the flagged text and suggestions.',
      inputSchema: z.object(targetSchema),
      execute: async (input) => check('spelling', input),
    }),

    check_grammar: tool({
      description: 'Check grammar (the offline Harper checker). Returns each finding with its paragraph id, location, the flagged text, the rule\'s message and suggestions.',
      inputSchema: z.object(targetSchema),
      execute: async (input) => check('grammar', input),
    }),

    use_script: tool({
      description:
        'Choose the kind of help this conversation needs, on your first turn: proofread, format (manuscript and house style), pacing (story beats and structure), ' +
        'stuck (questions and options for a stuck writer), explain-rule, or general. Returns the instructions for it.',
      inputSchema: z.object({ name: z.enum(SCRIPT_NAMES as [ScriptName, ...ScriptName[]]) }),
      execute: async ({ name }) => {
        if (!isScriptName(name)) return { error: `Unknown script "${String(name)}".` }
        ctx.onScript?.(name)
        return { script: name, instructions: scriptText(name) }
      },
    }),
  }
}
