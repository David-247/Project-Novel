import type { Node as PMNode, Schema } from '@tiptap/pm/model'
import { Step, StepMap, StepResult, type Mappable } from '@tiptap/pm/transform'
import type { CommentThread } from './model'

/**
 * A change of one comment thread (create, reply, edit, resolve, reopen, delete), as a ProseMirror
 * step that leaves the document as it is. Because it is a step, the main undo history records and
 * inverts it like any edit: undo of a reply is the step back to the thread before the reply, and
 * an action that also changes marks (create, delete) is one undo event with them. The comments
 * plugin applies these steps to its thread state (see extension.ts).
 *
 * `before` null = the thread is created; `after` null = it is deleted.
 */
export class CommentThreadStep extends Step {
  constructor(
    readonly threadId: string,
    readonly before: CommentThread | null,
    readonly after: CommentThread | null,
  ) {
    super()
  }

  apply(doc: PMNode): StepResult {
    return StepResult.ok(doc)
  }

  getMap(): StepMap {
    return StepMap.empty
  }

  invert(): CommentThreadStep {
    return new CommentThreadStep(this.threadId, this.after, this.before)
  }

  /** No positions: unaffected by mapping. */
  map(_mapping: Mappable): CommentThreadStep {
    void _mapping
    return this
  }

  merge(): Step | null {
    return null
  }

  toJSON(): Record<string, unknown> {
    return { stepType: 'commentThread', threadId: this.threadId, before: this.before, after: this.after }
  }

  static fromJSON(_schema: Schema, json: { threadId: string; before: CommentThread | null; after: CommentThread | null }): CommentThreadStep {
    void _schema
    return new CommentThreadStep(json.threadId, json.before, json.after)
  }
}

try {
  Step.jsonID('commentThread', CommentThreadStep)
} catch {
  // Already registered (module evaluated twice, e.g. hot reload).
}

