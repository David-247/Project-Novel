import type { Node as PMNode, Schema } from '@tiptap/pm/model'
import { Step, StepMap, StepResult, type Mappable } from '@tiptap/pm/transform'
import type { DocNodeJSON } from '@/shared/document'
import type { RewriteRecord, RewriteStatus } from '@/shared/store'

/**
 * The resolution fields of one re-write, as a history step sets them. `original` only when the step
 * changes it (Reopen takes the manuscript's text as the new original).
 */
export interface RewriteStepState {
  status: RewriteStatus
  /** 'original' or the kept version's id; null while open. */
  choice: string | null
  resolvedAt?: string
  original?: DocNodeJSON
}

/**
 * A change of one re-write's resolution (Keep Original, Keep This Version, Discard, Reopen) as a
 * ProseMirror step that leaves the document as it is, like the comments' CommentThreadStep. Being a
 * step, it is recorded and inverted by the main undo history with the text it goes with: one Mod-z
 * after Keep This Version puts the original text back and the re-write open again with every version;
 * redo applies both again. The anchor plugin (anchor.ts) reads these steps: the lock follows them at
 * once, and the store's `rewrite.rewrites` (rewrites.json) is updated to match after the dispatch.
 *
 * `before` null: the re-write is created (an undone Discard); `after` null: it is removed (Discard).
 * `record` is the whole re-write, kept for those two (the versions to restore).
 */
export class RewriteStateStep extends Step {
  constructor(
    readonly rewriteId: string,
    readonly anchor: string,
    readonly before: RewriteStepState | null,
    readonly after: RewriteStepState | null,
    readonly record: RewriteRecord | null = null,
  ) {
    super()
  }

  apply(doc: PMNode): StepResult {
    return StepResult.ok(doc)
  }

  getMap(): StepMap {
    return StepMap.empty
  }

  invert(): RewriteStateStep {
    return new RewriteStateStep(this.rewriteId, this.anchor, this.after, this.before, this.record)
  }

  /** No positions: unaffected by mapping. */
  map(_mapping: Mappable): RewriteStateStep {
    void _mapping
    return this
  }

  merge(): Step | null {
    return null
  }

  /** The re-write locks its passage after this step. */
  get opens(): boolean {
    return this.after?.status === 'open'
  }

  toJSON(): Record<string, unknown> {
    return { stepType: 'nvRewriteState', rewriteId: this.rewriteId, anchor: this.anchor, before: this.before, after: this.after, record: this.record }
  }

  static fromJSON(
    _schema: Schema,
    json: { rewriteId: string; anchor: string; before: RewriteStepState | null; after: RewriteStepState | null; record?: RewriteRecord | null },
  ): RewriteStateStep {
    void _schema
    return new RewriteStateStep(json.rewriteId, json.anchor, json.before, json.after, json.record ?? null)
  }
}

try {
  Step.jsonID('nvRewriteState', RewriteStateStep)
} catch {
  // Already registered (module evaluated twice, e.g. hot reload).
}

/** `r` with the fields of `s` (a re-write's resolution set by a step). */
export function withStepState(r: RewriteRecord, s: RewriteStepState): RewriteRecord {
  const { unknownStatus: _u, choice: _c, resolvedAt: _t, ...rest } = r
  void _u
  void _c
  void _t
  const out: RewriteRecord = { ...rest, status: s.status }
  if (s.choice) out.choice = s.choice
  if (s.resolvedAt) out.resolvedAt = s.resolvedAt
  if (s.original) {
    out.original = s.original
    delete out.originalChanged
  }
  return out
}

/** The store's re-writes after `steps` (in order). Returns `list` itself when nothing changes. */
export function applyStateSteps(list: readonly RewriteRecord[], steps: readonly RewriteStateStep[]): readonly RewriteRecord[] {
  let out = list
  for (const step of steps) {
    const i = out.findIndex((r) => r.id === step.rewriteId)
    if (!step.after) {
      if (i >= 0) out = [...out.slice(0, i), ...out.slice(i + 1)]
      continue
    }
    if (i < 0) {
      if (step.record) out = [...out, withStepState(step.record, step.after)]
      continue
    }
    const next = withStepState(out[i], step.after)
    if (JSON.stringify(next) === JSON.stringify(out[i])) continue
    const copy = out.slice()
    copy[i] = next
    out = copy
  }
  return out
}
