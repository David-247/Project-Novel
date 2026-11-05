import { getEditor } from '@/features/editor'
import { notifyCommandStateChanged, registerCommands, type Command } from '@/shared/commands'
import { useStore, type RootState } from '@/shared/store'
import {
  closeRewrite,
  focusSide,
  hasOpenRewrites,
  isViewOpen,
  newVersion,
  openList,
  rewritePassage,
  stepRewrite,
  toggleFlip,
  toggleShowDiff,
  wireRewriteAnchors,
} from './commands'
import { canChoose, discardRewrite, keepOriginal, keepVersion } from './choice'
import { REWRITE_CONTROLS as C } from './controls'

// After the comment groups (10-30): the re-write's own commands, then the ones of the open view.
const review = (order: number): Command['menu'] => ({ id: 'review', group: order < 50 ? 'rewrite' : 'rewrite-view', order })
// Ribbon: Review > Re-write. The group's own buttons show these four (an icon, short labels: src/ribbon-groups.tsx),
// so the placements only list them in the group's dropdown.
const ribbon = (order: number): Command['ribbon'] => ({ group: 'review.rewrite', order, display: 'menu' })

/** The re-write commands for the registry (Review menu, shortcuts, Keyboard Shortcuts sheet). */
export function rewriteCommands(): Command[] {
  const inView = isViewOpen
  return [
    {
      id: C.open.id,
      label: C.open.label,
      description: C.open.description,
      shortcut: C.open.shortcut,
      menu: review(40),
      ribbon: ribbon(10),
      // Acts on the manuscript's selection: not from another field or behind a dialog.
      guard: 'manuscript',
      isEnabled: () => !inView() && !!getEditor() && !useStore.getState().project.opening,
      run: () => void rewritePassage(),
    },
    { id: C.list.id, label: C.list.label, description: C.list.description, menu: review(41), ribbon: ribbon(20), guard: 'modal', isEnabled: () => useStore.getState().rewrite.rewrites.length > 0, run: () => openList(true) },
    { id: C.next.id, label: C.next.label, description: C.next.description, menu: review(42), ribbon: ribbon(40), guard: 'modal', isEnabled: hasOpenRewrites, run: () => void stepRewrite(1) },
    { id: C.prev.id, label: C.prev.label, description: C.prev.description, menu: review(43), ribbon: ribbon(30), guard: 'modal', isEnabled: hasOpenRewrites, run: () => void stepRewrite(-1) },
    {
      id: C.showDiff.id,
      label: C.showDiff.label,
      description: C.showDiff.description,
      shortcut: C.showDiff.shortcut,
      menu: review(50),
      guard: 'none',
      isEnabled: inView,
      isChecked: () => useStore.getState().rewrite.showDiff,
      run: toggleShowDiff,
    },
    { id: C.flip.id, label: C.flip.label, description: C.flip.description, shortcut: C.flip.shortcut, menu: review(51), guard: 'none', isEnabled: inView, run: toggleFlip },
    { id: C.focusLeft.id, label: C.focusLeft.label, description: C.focusLeft.description, shortcut: C.focusLeft.shortcut, menu: review(52), guard: 'none', isEnabled: inView, run: () => focusSide('left') },
    { id: C.focusRight.id, label: C.focusRight.label, description: C.focusRight.description, shortcut: C.focusRight.shortcut, menu: review(53), guard: 'none', isEnabled: inView, run: () => focusSide('right') },
    { id: C.newVersion.id, label: C.newVersion.label, description: C.newVersion.description, menu: review(54), guard: 'modal', isEnabled: inView, run: () => void newVersion() },
    // The choice: large buttons under each page of the view, the ribbon's Re-write group, the Review menu.
    // The view handles the shortcuts by key code (macOS: Option changes the letter); the registry's are for the sheet and menus.
    {
      id: C.keepOriginal.id,
      label: C.keepOriginal.label,
      description: C.keepOriginal.description,
      shortcut: C.keepOriginal.shortcut,
      menu: review(55),
      ribbon: ribbon(50),
      guard: 'modal',
      isEnabled: canChoose,
      run: () => void keepOriginal(),
    },
    {
      id: C.keepVersion.id,
      label: C.keepVersion.label,
      description: C.keepVersion.description,
      shortcut: C.keepVersion.shortcut,
      menu: review(56),
      ribbon: ribbon(60),
      guard: 'modal',
      isEnabled: canChoose,
      run: () => void keepVersion(),
    },
    { id: C.discard.id, label: C.discard.label, description: C.discard.description, menu: review(57), ribbon: ribbon(70), guard: 'modal', isEnabled: inView, run: () => void discardRewrite() },
    // Escape closes it inside the view (handled there, not a global shortcut).
    { id: C.close.id, label: C.close.label, description: C.close.description, menu: review(59), guard: 'modal', isEnabled: inView, run: () => closeRewrite() },
  ]
}

const watched = (s: RootState) => {
  const r = s.rewrite
  return [r.rewrites, r.openId, r.showDiff, r.problems, s.project.opening] as const
}

/** Register the re-write commands, wire the manuscript's anchors, keep the menu state fresh. Returns unregister. */
export function registerRewriteCommands(): () => void {
  const off = registerCommands(rewriteCommands())
  const unwire = wireRewriteAnchors()
  const offStore = useStore.subscribe((s, prev) => {
    const a = watched(s)
    const b = watched(prev)
    if (a.some((v, i) => v !== b[i])) notifyCommandStateChanged()
  })
  return () => {
    offStore()
    unwire()
    off()
  }
}
