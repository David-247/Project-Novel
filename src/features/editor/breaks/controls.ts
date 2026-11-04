import type { Editor } from '@tiptap/core'
import type { ToolbarControlMeta } from '../toolbar/controls'
import type { ChaptersStartOn } from './chapter-start'
import { SCENE_ORNAMENTS } from './nodes'
import { FOOTNOTE_INSERT } from '../footnote/controls'

export interface InsertControlMeta extends ToolbarControlMeta {
  /** One line for the tooltip. */
  description: string
}

/** The Insert menu button. */
export const INSERT_MENU_CONTROL: InsertControlMeta = {
  id: 'insert.menu',
  label: 'Insert',
  description: 'Add a page break, a new chapter or a scene break at the cursor.',
}

export interface InsertItem extends InsertControlMeta {
  run: (editor: Editor) => void
}

/**
 * Items of the Insert menu, in order. Adding an item (e.g. Footnote) is one entry here: the menu and
 * the tooltips registry both read this array.
 */
export const INSERT_ITEMS: readonly InsertItem[] = [
  {
    id: 'insert.pageBreak',
    label: 'Page break',
    shortcut: 'Mod-Enter',
    description: 'Start the text after the cursor on a new page.',
    run: (editor) => editor.chain().focus().insertPageBreak().run(),
  },
  {
    id: 'insert.newChapter',
    label: 'New chapter',
    shortcut: 'Mod-Shift-Enter',
    description: 'Add a chapter title at the cursor. Chapters open on a new page, or a right-hand page.',
    run: (editor) => editor.chain().focus().insertChapter().run(),
  },
  {
    id: 'insert.sceneBreak',
    label: 'Scene break',
    shortcut: 'Mod-Alt-Enter',
    description: 'Add a centred ornament between scenes. Typing *** or ### on a line does the same.',
    run: (editor) => editor.chain().focus().insertSceneBreak().run(),
  },
  // No focus() in the chain: the footnote editor takes focus (a deferred manuscript focus would steal it).
  { ...FOOTNOTE_INSERT, run: (editor) => editor.commands.insertFootnote() },
]

/** "Chapters start on" radio items (a book setting: rewrites the Chapter Title style). */
export const CHAPTER_START_CONTROLS: ReadonlyArray<InsertControlMeta & { value: ChaptersStartOn }> = [
  {
    id: 'insert.chapterStart.page',
    value: 'page',
    label: 'Next page',
    description: 'Each chapter starts on the next page, left or right.',
  },
  {
    id: 'insert.chapterStart.recto',
    value: 'recto',
    label: 'Right-hand page',
    description: 'Each chapter starts on a right-hand page, leaving a blank left-hand page when needed.',
  },
]

const ORNAMENT_IDS = ['stars', 'hash', 'fleuron', 'blank'] as const
/** Ornament radio items for scene breaks. */
export const ORNAMENT_CONTROLS: ReadonlyArray<InsertControlMeta & { value: string }> = SCENE_ORNAMENTS.map((o, i) => ({
  id: `insert.ornament.${ORNAMENT_IDS[i]}`,
  value: o.value,
  label: o.label,
  description:
    o.value === ''
      ? 'Scene breaks show as an empty line. Applies to the selected scene break and to new ones.'
      : `Scene breaks show ${o.label}. Applies to the selected scene break and to new ones.`,
}))

/** Every control of the menu, for the tooltips registry. */
export const INSERT_CONTROLS: readonly InsertControlMeta[] = [
  INSERT_MENU_CONTROL,
  ...INSERT_ITEMS,
  ...CHAPTER_START_CONTROLS,
  ...ORNAMENT_CONTROLS,
]
