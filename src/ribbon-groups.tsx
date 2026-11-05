import type { ReactElement, ReactNode } from 'react'
import { TrimSizePicker } from '@/features/book-settings'
import { COMMENT_CONTROLS, CommentsPanelButton, NewCommentButton } from '@/features/comments'
import {
  AlignmentControls,
  FIND_CONTROLS,
  FindButton,
  FontControls,
  HistoryButtons,
  InsertMenu,
  ListControls,
  SpacingControls,
  StylesControls,
  TextStyleControls,
  ToolbarItem,
} from '@/features/editor'
import { FootnoteOptionsButton } from '@/features/footnotes'
import { HeaderFooterButton } from '@/features/header-footer'
import { CommandButton, SplitCommandButton } from '@/features/ribbon'
import { REWRITE_CONTROLS as RW } from '@/features/rewrite'
import { BY_AUTHOR_SUBMENU, MarkupViewMenu, TRACK_CHANGES_CONTROLS as TC, TrackChangesButton } from '@/features/track-changes'
import { getCommand, isCommandEnabled, useCommandStateVersion, useCommands } from '@/shared/commands'
import { registerRibbonGroups, type RibbonGroupSpec, type RibbonMenuEntry } from '@/shared/ribbon'
import { SurfacePicker } from '@/shared/theme'

/**
 * The ribbon's groups (composition root: the one place that puts slices' controls side by side).
 * Tabs, groups and order follow Word's ribbon; docs/design.md, "Ribbon", has the table and the rules.
 * A slice adds a plain command button by giving its command a `ribbon` placement in one of these
 * groups; a new group with its own controls is one entry here.
 */

const cmd = (id: string): RibbonMenuEntry => ({ cmd: id })
const sub = (menu: Extract<RibbonMenuEntry, { submenu: unknown }>['submenu']['menu'], label: string): RibbonMenuEntry => ({ submenu: { menu, label } })

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  )
}

const icons = {
  font: () => (
    <Icon>
      <path d="M3.5 16l5-12h1l5 12M5.6 11.5h7.8" />
    </Icon>
  ),
  paragraph: () => (
    <Icon>
      <path d="M3 4.5h14M6 8.5h11M3 12.5h14M6 16.5h11" />
    </Icon>
  ),
  styles: () => (
    <Icon>
      <path d="M2.5 15.5l3.8-10h1L11 15.5M3.9 12h4.8M13 10.6c.6-.6 1.3-.9 2.1-.9 1.3 0 2 .7 2 1.9v3.9M17.1 12.8c-2.8 0-4.1.6-4.1 1.5 0 .7.6 1.2 1.4 1.2 1.5 0 2.7-1 2.7-2.6" />
    </Icon>
  ),
  find: () => (
    <Icon>
      <circle cx="8.5" cy="8.5" r="5" />
      <path d="M12.3 12.3L17 17" />
    </Icon>
  ),
  breaks: () => (
    <Icon>
      <path d="M4 3v5h12V3M4 17v-5h12v5M2 10h2.5M7 10h2M11 10h2M15.5 10H18" />
    </Icon>
  ),
  footnote: () => (
    <Icon>
      <path d="M3 5h9M3 9h9M3 13h5M14 4.5l1.5-1v5M3 16.5h14" />
    </Icon>
  ),
  comment: () => (
    <Icon>
      <path d="M3.5 4h13v9H9l-4 3.5V13H3.5z" />
    </Icon>
  ),
  pageSetup: () => (
    <Icon>
      <path d="M5 2.5h7l3 3v12H5zM12 2.5v3h3M7.5 8.5h5v6h-5z" />
    </Icon>
  ),
  headers: () => (
    <Icon>
      <path d="M4.5 2.5h11v15h-11zM7 5.5h6M7 14.5h1.5M11.5 14.5H13" />
    </Icon>
  ),
  paper: () => (
    <Icon>
      <circle cx="10" cy="10" r="6.5" />
      <path d="M10 3.5v13A6.5 6.5 0 0010 3.5z" fill="currentColor" />
    </Icon>
  ),
  book: () => (
    <Icon>
      <path d="M10 5.5C8.5 4 6 3.5 3 3.5v12c3 0 5.5.5 7 2 1.5-1.5 4-2 7-2v-12c-3 0-5.5.5-7 2zM10 5.5v12" />
    </Icon>
  ),
  tracking: () => (
    <Icon>
      <path d="M3 5h8M3 9h6M3 13h4M10.5 16.5l.8-3 5-5 2.2 2.2-5 5z" />
    </Icon>
  ),
  changes: () => (
    <Icon>
      <path d="M3 10.5l3.5 3.5L13 6.5M12 14l2 2 3.5-4" />
    </Icon>
  ),
  accept: () => (
    <Icon>
      <path d="M3.5 10.5l4 4 9-9" />
    </Icon>
  ),
  reject: () => (
    <Icon>
      <path d="M5 5l10 10M15 5L5 15" />
    </Icon>
  ),
  rewrite: () => (
    <Icon>
      <path d="M4 7a6 6 0 0110.5-2.5M16 13a6 6 0 01-10.5 2.5M14.5 2v2.5H12M5.5 18v-2.5H8" />
    </Icon>
  ),
  views: () => (
    <Icon>
      <path d="M2.5 4.5h6.5v11H2.5zM11 4.5h6.5v11H11z" />
    </Icon>
  ),
  zoom: () => (
    <Icon>
      <circle cx="8.5" cy="8.5" r="5" />
      <path d="M12.3 12.3L17 17M6.5 8.5h4M8.5 6.5v4" />
    </Icon>
  ),
  show: () => (
    <Icon>
      <path d="M2.5 4h15v12h-15zM12.5 4v12M14.5 7.5h1M14.5 10h1" />
    </Icon>
  ),
  window: () => (
    <Icon>
      <path d="M3 7V3h4M13 3h4v4M17 13v4h-4M7 17H3v-4" />
    </Icon>
  ),
}

const item = (node: ReactElement) => <ToolbarItem>{node}</ToolbarItem>

/**
 * A slice's own control for a registry command (Find, New Comment, Track Changes), disabled while the
 * command is: the ribbon then follows the registry's gate (the re-write view turns these off) like the
 * menus do. Only the enabled state is taken from the command; the control still runs its own action.
 */
function GatedItem({ commandId, children }: { commandId: string; children: ReactElement }) {
  useCommandStateVersion()
  const command = getCommand(commandId)
  return <ToolbarItem disabled={!!command && !isCommandEnabled(command)}>{children}</ToolbarItem>
}
const gated = (commandId: string, node: ReactElement) => <GatedItem commandId={commandId}>{node}</GatedItem>

/**
 * A registry command's ribbon button with an optional icon and a shorter visible label (the tooltip keeps
 * the command's). The command has `display: 'menu'`, so it shows once.
 */
function RibbonCommand({ commandId, icon, label }: { commandId: string; icon?: () => ReactElement; label?: string }) {
  const command = useCommands().find((c) => c.id === commandId)
  return command ? <CommandButton command={command} icon={icon} label={label} /> : null
}

export const RIBBON_GROUPS: RibbonGroupSpec[] = [
  // ---- Home ----
  {
    id: 'home.font',
    tab: 'home',
    label: 'Font',
    order: 20,
    priority: 90,
    icon: icons.font,
    hasCompact: true,
    Content: ({ size }) => (
      <>
        <FontControls compact={size === 'compact'} />
        <TextStyleControls />
      </>
    ),
    menu: [sub('format', 'Font'), sub('format', 'Font Size'), cmd('toolbar.bold'), cmd('toolbar.italic'), cmd('toolbar.underline')],
  },
  {
    id: 'home.paragraph',
    tab: 'home',
    label: 'Paragraph',
    order: 30,
    priority: 75,
    icon: icons.paragraph,
    hasCompact: true,
    Content: ({ size }) => (
      <>
        <ListControls />
        <AlignmentControls />
        <SpacingControls compact={size === 'compact'} />
      </>
    ),
    compactMenu: { label: 'Spacing', entries: [sub('format', 'Line Spacing'), sub('format', 'Space After'), sub('format', 'First-Line Indent')] },
    menu: [
      cmd('toolbar.bulletList'),
      cmd('toolbar.orderedList'),
      cmd('toolbar.alignLeft'),
      cmd('toolbar.alignCenter'),
      cmd('toolbar.alignRight'),
      cmd('toolbar.alignJustify'),
      sub('format', 'Line Spacing'),
      sub('format', 'Space After'),
      sub('format', 'First-Line Indent'),
      cmd('toolbar.indentDecrease'),
      cmd('toolbar.indentIncrease'),
    ],
  },
  {
    id: 'home.styles',
    tab: 'home',
    label: 'Styles',
    order: 40,
    priority: 80,
    icon: icons.styles,
    Content: () => <StylesControls bare />,
    menu: [sub('format', 'Paragraph Style'), cmd('styles.clearFormatting'), cmd('styles.edit'), cmd('styles.manage')],
  },
  {
    id: 'home.editing',
    tab: 'home',
    label: 'Editing',
    order: 50,
    priority: 60,
    icon: icons.find,
    // Two small buttons: a dropdown would not be narrower.
    collapsible: false,
    Content: () => gated(FIND_CONTROLS.open.id, <FindButton />),
    menu: [cmd('find.open')],
  },
  // ---- Insert ----
  {
    id: 'insert.breaks',
    tab: 'insert',
    label: 'Breaks',
    order: 10,
    priority: 90,
    icon: icons.breaks,
    buttons: 'before',
    // Compact: only the Break Options menu, which also holds the three breaks, plus "Chapters start on"
    // and the ornament, which a dropdown of registry commands could not offer. So it never collapses.
    hasCompact: true,
    compactButtons: false,
    collapsible: false,
    Content: () => item(<InsertMenu label="Break Options" />),
  },
  { id: 'insert.footnotes', tab: 'insert', buttons: 'before', label: 'Footnotes', order: 20, priority: 80, icon: icons.footnote, Content: () => item(<FootnoteOptionsButton />), menu: [cmd('footnote.options')] },
  { id: 'insert.comments', tab: 'insert', label: 'Comments', order: 30, priority: 70, icon: icons.comment },
  // ---- Layout ----
  { id: 'layout.pageSetup', tab: 'layout', label: 'Page Setup', order: 10, priority: 90, icon: icons.pageSetup, Content: () => item(<TrimSizePicker />), menu: [sub('file', 'Page Setup')] },
  { id: 'layout.headers', tab: 'layout', label: 'Header & Footer', order: 20, priority: 80, icon: icons.headers, Content: () => item(<HeaderFooterButton />), menu: [cmd('book.headerFooter')] },
  {
    id: 'layout.paper',
    tab: 'layout',
    label: 'Paper',
    order: 30,
    priority: 70,
    icon: icons.paper,
    Content: () => <SurfacePicker wrap={(button) => <ToolbarItem>{button}</ToolbarItem>} />,
    menu: [sub('view', 'Paper')],
  },
  { id: 'layout.book', tab: 'layout', label: 'Book', order: 40, priority: 60, icon: icons.book },
  // ---- Review ----
  {
    id: 'review.tracking',
    tab: 'review',
    label: 'Tracking',
    order: 10,
    priority: 90,
    icon: icons.tracking,
    Content: () => (
      <>
        {gated(TC.track.id, <TrackChangesButton />)}
        {item(<MarkupViewMenu />)}
      </>
    ),
    menu: [cmd('review.track'), sub('view', 'Markup')],
  },
  // Previous / Next Change are placed by their commands (buttons first); Accept ▾ / Reject ▾ are Word's
  // split buttons: the main half accepts / rejects the change, the arrow lists the rest.
  {
    id: 'review.changes',
    tab: 'review',
    label: 'Changes',
    order: 20,
    priority: 85,
    icon: icons.changes,
    buttons: 'before',
    Content: () => (
      <>
        <SplitCommandButton
          commandId={TC.accept.id}
          label="Accept"
          icon={icons.accept}
          menuControlId={TC.acceptOptions.id}
          menuLabel={TC.acceptOptions.label}
          entries={[cmd(TC.accept.id), cmd(TC.acceptNext.id), cmd(TC.acceptAll.id), sub('review', BY_AUTHOR_SUBMENU.accept)]}
        />
        <SplitCommandButton
          commandId={TC.reject.id}
          label="Reject"
          icon={icons.reject}
          menuControlId={TC.rejectOptions.id}
          menuLabel={TC.rejectOptions.label}
          entries={[cmd(TC.reject.id), cmd(TC.rejectNext.id), cmd(TC.rejectAll.id), sub('review', BY_AUTHOR_SUBMENU.reject)]}
        />
      </>
    ),
    menu: [
      cmd(TC.prevChange.id),
      cmd(TC.nextChange.id),
      cmd(TC.accept.id),
      cmd(TC.acceptNext.id),
      cmd(TC.acceptAll.id),
      sub('review', BY_AUTHOR_SUBMENU.accept),
      cmd(TC.reject.id),
      cmd(TC.rejectNext.id),
      cmd(TC.rejectAll.id),
      sub('review', BY_AUTHOR_SUBMENU.reject),
    ],
  },
  { id: 'review.comments', tab: 'review', label: 'Comments', order: 30, priority: 80, icon: icons.comment, Content: () => gated(COMMENT_CONTROLS.new.id, <NewCommentButton />), menu: [cmd('comment.new')] },
  // Re-write Passage… (icon), Re-writes…, Previous / Next Re-write: the group's own buttons; the commands'
  // `ribbon` placements (display 'menu') list all four in the dropdown, in order.
  {
    id: 'review.rewrite',
    tab: 'review',
    label: 'Re-write',
    order: 40,
    priority: 70,
    icon: icons.rewrite,
    // Short visible labels (Word's "Previous" / "Next" in its Comments group), so the group stays open at
    // a 1280px window; the tooltips and the dropdown keep the full names.
    Content: () => (
      <>
        <RibbonCommand commandId={RW.open.id} icon={icons.rewrite} label="Re-write" />
        <RibbonCommand commandId={RW.list.id} label="Re-writes" />
        <RibbonCommand commandId={RW.prev.id} label="Previous" />
        <RibbonCommand commandId={RW.next.id} label="Next" />
      </>
    ),
  },
  // ---- View ----
  // Page-turn / continuous scroll (T5) place their commands here.
  { id: 'view.views', tab: 'view', label: 'Views', order: 10, priority: 90, icon: icons.views },
  { id: 'view.zoom', tab: 'view', label: 'Zoom', order: 20, priority: 80, icon: icons.zoom },
  { id: 'view.show', tab: 'view', label: 'Show', order: 30, priority: 70, icon: icons.show, Content: () => item(<CommentsPanelButton />), menu: [cmd('comment.panel')] },
  { id: 'view.window', tab: 'view', label: 'Window', order: 40, priority: 60, icon: icons.window },
]

/** Undo / Redo on every tab, left of the tabs (Word's Quick Access Toolbar). */
export function RibbonQuickAccess() {
  return <HistoryButtons wrap={(button, { disabled }) => <ToolbarItem disabled={disabled}>{button}</ToolbarItem>} />
}

/** Register the app's ribbon groups; returns unregister. */
export function registerAppRibbon(): () => void {
  return registerRibbonGroups(RIBBON_GROUPS)
}
