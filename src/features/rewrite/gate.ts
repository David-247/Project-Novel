import { COMMENT_CONTROLS } from '@/features/comments'
import { FIND_CONTROLS, getActiveEditor } from '@/features/editor'
import { TRACK_CHANGES_CONTROLS } from '@/features/track-changes'
import { commandGuard, type Command } from '@/shared/commands'

/**
 * Which commands run while the re-write view is open (registered as the registry's command gate, so
 * menus, the native menu, shortcuts and runCommand all follow it):
 * - text commands (guard 'manuscript': formatting, styles, Edit history / clipboard, Insert breaks) act
 *   on the revision while it has (or last had) the focus in the view, through the editor slice's
 *   active editor; with the focus elsewhere in the view they are disabled, except Edit history /
 *   clipboard in a text field (the version name), which act on the field;
 * - commands about the manuscript as a whole make no sense on a revision and are disabled: Insert
 *   Footnote, comments, Find / Replace, Track Changes and its review (Next Change, Accept / Reject ...),
 *   Go to Page, page view, zoom, navigation mode and the spread turns (Previous / Next Spread ...).
 */
// Built on first use: this module is evaluated inside the editor <-> rewrite import cycle.
let off: Set<string> | null = null
const OFF = () =>
  (off ??= new Set<string>([
    'footnote.insert',
    COMMENT_CONTROLS.new.id,
    'insert.comment',
    COMMENT_CONTROLS.next.id,
    COMMENT_CONTROLS.prev.id,
    FIND_CONTROLS.open.id,
    'edit.replace',
    TRACK_CHANGES_CONTROLS.track.id,
    'edit.go_to_page',
  ]))

const focusedInput = () => {
  const el = typeof document === 'undefined' ? null : document.activeElement
  return el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color'].includes(el.type))
}

/**
 * The View menu groups about the manuscript's pages (pagination commands.ts) and its comments pane
 * (comments 'panels'). The rest of View (Markup, Paper, Full Screen) shows the view's pages too.
 */
const VIEW_GROUPS = new Set<string>(['layout', 'zoom', 'navigation', 'spreads', 'panels'])

/**
 * The Review menu groups that stay on: the re-write's own (menu-commands.ts). Every other Review
 * command (Track Changes and its review, comments, any group added later) acts on the hidden
 * manuscript: off. An allow-list, so a new Review group cannot leak onto the manuscript.
 */
const REVIEW_ON = new Set<string>(['rewrite', 'rewrite-view'])

/** Copy works from either page (the original can be read and copied). */
const ANY_PAGE = new Set<string>(['edit.copy'])

export function rewriteCommandGate(cmd: Command): boolean {
  if (OFF().has(cmd.id)) return false
  const menu = cmd.menu
  // Page view, zoom, Book / Continuous Scroll, the spread turns and the comments pane: behind the view.
  if (menu?.id === 'view' && VIEW_GROUPS.has(menu.group)) return false
  // Track Changes and its review (Previous / Next Change, Accept / Reject, All, by Author), the
  // comments (New, Next / Previous, Show Resolved): they act on the manuscript, which the view hides.
  if (menu?.id === 'review' && !REVIEW_ON.has(menu.group)) return false
  if (ANY_PAGE.has(cmd.id)) return true
  // A text field of the view (the version name): Edit history / clipboard act on the field, as the
  // registry's commands do for any text input.
  if (menu?.id === 'edit' && (menu.group === 'history' || menu.group === 'clipboard') && focusedInput()) return true
  if (commandGuard(cmd) === 'manuscript') return getActiveEditor() !== null
  return true
}
