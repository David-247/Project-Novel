import { registerCommand } from '@/shared/commands'
import { FOOTNOTE_OPTION_CONTROLS } from './controls'
import { openFootnoteOptions } from './FootnoteOptions'

/** Format > Footnote Options… (same id and dialog as the toolbar button). Returns unregister. */
export function registerFootnoteCommands(): () => void {
  return registerCommand({
    id: FOOTNOTE_OPTION_CONTROLS.open.id,
    label: 'Footnote Options…',
    description: FOOTNOTE_OPTION_CONTROLS.open.description,
    menu: { id: 'format', group: 'book', order: 70 },
    run: openFootnoteOptions,
  })
}
