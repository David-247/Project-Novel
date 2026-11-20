import { useSyncExternalStore } from 'react'
import { getEditor, registerContextMenuItems, type ContextMenuContext, type MenuItem } from '@/features/editor'
import { onProjectOpened, registerBeforeDocumentReplace, registerExitTask } from '@/features/storage'
import { notifyCommandStateChanged, registerCommands, type Command } from '@/shared/commands'
import { useStore } from '@/shared/store'
import { loadTutorConnections } from './connections/store'
import { useTutorHistory } from './history/store'
import { attach, beforeDocumentReplace, connectionChanged, projectChanged, requestComposerFocus, shutdown } from './panel/chat'
import { TUTOR_CONTROLS as C } from './panel/controls'
import { SparkleIcon } from './panel/icons'

/**
 * The tutor panel's open state, its command (View ▸ Tutor, Review ▸ Tutor, View ▸ Show ▸ Tutor,
 * Ctrl/Cmd+Shift+Y) and the manuscript's "Ask the Tutor About This". The panel docks at the right of the
 * pages and floats over them below 768 px, like the navigation pane. Its open state is not saved: the
 * tutor starts closed, and opening it sends nothing.
 */

/** The panel's root element carries this attribute (focus checks, tests). */
export const TUTOR_PANEL_ATTR = 'data-tutor-panel'

let open = false
const listeners = new Set<() => void>()
const emit = () => {
  listeners.forEach((l) => l())
  notifyCommandStateChanged()
}

export const isTutorOpen = (): boolean => open

export function subscribeTutorOpen(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function useTutorOpen(): boolean {
  return useSyncExternalStore(subscribeTutorOpen, isTutorOpen, () => false)
}

/** Show the panel and put the focus in the composer (Copilot opens on its chat box). */
export function openTutor(): void {
  if (!open) {
    open = true
    emit()
  }
  requestComposerFocus()
}

const focusInPanel = () => !!document.activeElement?.closest(`[${TUTOR_PANEL_ATTR}]`)

/** Back to the manuscript (Escape in the panel, closing it from inside). */
export function focusManuscript(): void {
  const ed = getEditor()
  if (ed && !ed.isDestroyed) ed.view.focus()
}

/** Hide the panel: a reply still coming is stopped and the chat saved (Review Focus 5). */
export function closeTutor(): void {
  if (!open) return
  const inside = focusInPanel()
  open = false
  emit()
  void shutdown()
  if (inside) focusManuscript()
}

export function toggleTutor(): void {
  if (open) closeTutor()
  else openTutor()
}

/** What "Ask the Tutor About This" attaches: the selection, else the paragraph at the menu's place. */
function askAboutTarget(ctx: ContextMenuContext): { from: number; to: number; label: string } | null {
  const { selection } = ctx
  if (!selection.empty) return { from: selection.from, to: selection.to, label: 'Selection' }
  const $pos = ctx.editor.state.doc.resolve(ctx.pos)
  for (let d = $pos.depth; d > 0; d--) {
    const node = $pos.node(d)
    if (node.isTextblock) return node.content.size ? { from: $pos.start(d), to: $pos.end(d), label: 'Paragraph' } : null
  }
  return null
}

/** The manuscript's context menu: "Ask the Tutor About This" (Word's order: other actions, 200-299). */
export function tutorMenuItems(ctx: ContextMenuContext): MenuItem[] {
  const target = askAboutTarget(ctx)
  return [
    {
      id: C.askAbout.id,
      label: C.askAbout.label,
      group: 'actions',
      order: 200,
      disabled: !target,
      run: () => {
        if (!target) return
        attach({ kind: 'selection', from: target.from, to: target.to }, target.label)
        openTutor()
      },
    },
  ]
}

export function tutorCommands(): Command[] {
  return [
    {
      id: C.toggle.id,
      label: C.toggle.label,
      description: C.toggle.description,
      shortcut: C.toggle.shortcut,
      // After Comments Panel (40) and Spelling & Grammar (50): the panels over the pages.
      menu: { id: 'view', group: 'panels', order: 60 },
      // Review ▸ Proofing, after Spelling & Grammar (5) and Word Count (10), with the AI sparkle (Word keeps
      // its Editor in Proofing). View ▸ Show lists it too (ribbon-groups).
      ribbon: { group: 'review.proofing', order: 20, icon: SparkleIcon },
      guard: 'modal',
      isChecked: isTutorOpen,
      run: toggleTutor,
    },
  ]
}

/**
 * The tutor's wiring (composition root, once): its command, its context menu item, the history flush on
 * quit (must-do 4), the saved connections once preferences are read (the active one is a preference;
 * a store subscription, so the app does not render again for it), and a stop on every project change (Review Focus 5: project close emits no event, so the open
 * project's path is watched too). Returns unregister.
 */
export function registerTutorCommands(): () => void {
  const offs = [
    registerCommands(tutorCommands()),
    registerContextMenuItems(tutorMenuItems),
    registerExitTask(() => useTutorHistory.getState().flush()),
    // Before another manuscript is loaded (open, new, close, restore): stop, then save to this project (C1, M1).
    registerBeforeDocumentReplace(beforeDocumentReplace),
    onProjectOpened(() => projectChanged()),
    useStore.subscribe((s, p) => {
      if (s.project.path !== p.project.path) projectChanged()
      if (s.tutorConnections.activeId !== p.tutorConnections.activeId) connectionChanged()
      if (s.preferences.loaded && !p.preferences.loaded) loadConnections()
    }),
  ]
  if (useStore.getState().preferences.loaded) loadConnections()
  return () => offs.forEach((off) => off())
}

/** Read the saved connections (once preferences are loaded: they name the active one). */
function loadConnections(): void {
  loadTutorConnections().catch((e: unknown) => console.error('[tutor] the connections could not be read', e))
}

/** Test-only. */
export function __resetTutorPanelForTests(): void {
  open = false
  listeners.forEach((l) => l())
}
