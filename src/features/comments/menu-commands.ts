import { notifyCommandStateChanged, registerCommands, type Command } from '@/shared/commands'
import { useStore, type RootState } from '@/shared/store'
import {
  getCommentsViewEditable,
  isCommentsNarrow,
  newComment,
  nextComment,
  prevComment,
  subscribeCommentsNarrow,
  toggleCommentsPanel,
  toggleShowResolved,
} from './commands'
import { COMMENT_CONTROLS, NEW_COMMENT_SHORTCUT } from './controls'

const comments = () => useStore.getState().comments

/** Some thread Next / Previous Comment can reach (store mirror; hidden ones are skipped by the step). */
const hasShownThreads = () => {
  const c = comments()
  return c.threads.some((t) => c.showResolved || !t.resolved)
}

/** The comment commands for the registry (menus, shortcuts, Keyboard Shortcuts sheet). */
export function commentCommands(): Command[] {
  const review = (group: string, order: number): Command['menu'] => ({ id: 'review', group, order })
  return [
    {
      id: COMMENT_CONTROLS.new.id,
      label: 'New Comment',
      description: COMMENT_CONTROLS.new.description,
      shortcut: NEW_COMMENT_SHORTCUT,
      menu: review('comments', 10),
      isEnabled: getCommentsViewEditable,
      run: () => void newComment(),
    },
    {
      // The same action in Insert (the registry places a command in one menu; the shortcut lives on Review's).
      id: 'insert.comment',
      label: 'Comment',
      description: COMMENT_CONTROLS.new.description,
      menu: { id: 'insert', group: 'notes', order: 20 },
      isEnabled: getCommentsViewEditable,
      run: () => void newComment(),
    },
    {
      id: COMMENT_CONTROLS.next.id,
      label: 'Next Comment',
      description: COMMENT_CONTROLS.next.description,
      menu: review('navigate', 20),
      isEnabled: hasShownThreads,
      run: () => void nextComment(),
    },
    {
      id: COMMENT_CONTROLS.prev.id,
      label: 'Previous Comment',
      description: COMMENT_CONTROLS.prev.description,
      menu: review('navigate', 21),
      isEnabled: hasShownThreads,
      run: () => void prevComment(),
    },
    {
      id: COMMENT_CONTROLS.showResolved.id,
      label: 'Show Resolved Comments',
      description: COMMENT_CONTROLS.showResolved.description,
      menu: review('show', 30),
      isChecked: () => comments().showResolved,
      run: () => void toggleShowResolved(),
    },
    {
      id: COMMENT_CONTROLS.panel.id,
      label: 'Comments Panel',
      description: COMMENT_CONTROLS.panel.description,
      menu: { id: 'view', group: 'panels', order: 40 },
      isChecked: () => (isCommentsNarrow() ? comments().drawerOpen : comments().panelOpen),
      run: () => void toggleCommentsPanel(),
    },
  ]
}

const watched = (s: RootState) => {
  const c = s.comments
  return [c.threads, c.showResolved, c.panelOpen, c.drawerOpen] as const
}

/** Register the comment commands and keep their enabled / checked state fresh. Returns unregister. */
export function registerCommentsCommands(): () => void {
  const off = registerCommands(commentCommands())
  const offStore = useStore.subscribe((s, prev) => {
    const a = watched(s)
    const b = watched(prev)
    if (a.some((v, i) => v !== b[i])) notifyCommandStateChanged()
  })
  const offNarrow = subscribeCommentsNarrow(notifyCommandStateChanged)
  return () => {
    offNarrow()
    offStore()
    off()
  }
}
