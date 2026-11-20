/** One finding in a block of text. Offsets are UTF-16 code units (what JavaScript and ProseMirror count). */
export interface Finding {
  start: number
  /** Exclusive. */
  end: number
  kind: 'spelling' | 'grammar'
  /** The Harper rule that raised it (stable within one Harper version). */
  rule: string
  message: string
  /** At most five replacements for [start, end); an empty one means delete the text. */
  suggestions: string[]
}

/** A block of plain text to check. `id` is the caller's (a paragraph's id); results come back by it. */
export interface Block {
  id: string
  text: string
}

export type DictionaryScope = 'user' | 'project'
