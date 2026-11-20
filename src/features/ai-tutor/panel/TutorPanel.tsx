import { useSyncExternalStore, type KeyboardEvent } from 'react'
import { useStore } from '@/shared/store'
import { cn, focusRing, IconButton, Tooltip } from '@/shared/ui'
import { closeTutor, focusManuscript, TUTOR_PANEL_ATTR, useTutorOpen } from '../commands'
import { useTutorHistory } from '../history/store'
import { askDeleteChat, newChat, openChat, showHistory, useTutorChat } from './chat'
import { Composer } from './Composer'
import { connectProvider } from './connect'
import { TUTOR_CONTROLS as C } from './controls'
import { BackIcon, CloseIcon, HistoryIcon, NewChatIcon, SparkleIcon, TrashIcon } from './icons'
import { MessageList } from './MessageList'
import './tutor.css'

/** Below this window width the panel floats over the pages instead of docking (the navigation pane's rule). */
export const OVERLAY_MAX_WIDTH = 767
const OVERLAY_QUERY = `(max-width: ${OVERLAY_MAX_WIDTH}px)`
/** Docked width (Copilot's pane is about this wide); the overlay leaves a strip of page showing. */
export const PANEL_WIDTH = 360

function subscribeMedia(cb: () => void) {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {}
  const mq = window.matchMedia(OVERLAY_QUERY)
  mq.addEventListener('change', cb)
  return () => mq.removeEventListener('change', cb)
}
const isOverlay = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(OVERLAY_QUERY).matches

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const when = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : dateFormat.format(d)
}

function HistoryList() {
  const chats = useTutorHistory((s) => s.chats)
  const error = useTutorHistory((s) => s.error)
  const hasProject = useStore((s) => s.project.path !== null)
  const current = useTutorChat((s) => s.chatId)
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="tutor-history">
      <div className="flex shrink-0 items-center gap-1 px-2 py-1.5">
        <Tooltip controlId={C.historyBack.id}>
          <IconButton label={C.historyBack.label} data-control-id={C.historyBack.id} onClick={() => showHistory(false)}>
            <BackIcon />
          </IconButton>
        </Tooltip>
        <h3 className="text-ui-sm font-semibold text-text">Chat history</h3>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2">
        {!hasProject ? (
          <p className="px-2 py-2 text-ui-sm text-text-muted">Open a project to keep its chats. Chats are saved on this computer, never in the project folder.</p>
        ) : chats.length === 0 ? (
          <p className="px-2 py-2 text-ui-sm text-text-muted">No chats yet for this project.</p>
        ) : (
          <ul className="flex flex-col gap-0.5" aria-label="Chats">
            {chats.map((c) => (
              <li key={c.id} className={cn('group flex items-center gap-1 rounded-control', c.id === current ? 'bg-accent-soft' : 'hover:bg-surface-hover')}>
                <Tooltip copy={{ title: c.title, description: C.historyOpen.description }} side="left">
                  <button
                    type="button"
                    data-control-id={C.historyOpen.id}
                    aria-current={c.id === current ? 'true' : undefined}
                    onClick={() => void openChat(c.id)}
                    className={cn('flex min-h-control-lg min-w-0 flex-1 flex-col items-start rounded-control px-2 py-1 text-left', focusRing)}
                  >
                    <span className={cn('w-full truncate text-ui-sm font-medium', c.id === current ? 'text-accent' : 'text-text')}>{c.title}</span>
                    <span className="text-ui-xs text-text-muted">{when(c.updatedAt)}</span>
                  </button>
                </Tooltip>
                <Tooltip copy={{ title: `Delete “${c.title}”`, description: C.historyDelete.description }} side="left">
                  <IconButton label={`Delete chat “${c.title}”`} data-control-id={C.historyDelete.id} onClick={() => void askDeleteChat(c.id, c.title)}>
                    <TrashIcon />
                  </IconButton>
                </Tooltip>
              </li>
            ))}
          </ul>
        )}
        {error ? (
          <p className="px-2 py-2 text-ui-sm text-danger" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  )
}

/**
 * The tutor panel (design, "Chat panel"): docked at the right of the pages, floating over them below
 * 768 px like the navigation pane. Header: the title, ⟲ (chat history), New Chat and ✕. Then the
 * conversation (the greeting and suggested prompts on a new chat) and the composer with the model
 * picker. Mount once, as AppShell's `sidePanel`.
 */
export function TutorPanel() {
  const open = useTutorOpen()
  const overlay = useSyncExternalStore(subscribeMedia, isOverlay, () => false)
  const view = useTutorChat((s) => s.view)
  if (!open) return null
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return
    e.preventDefault()
    // In the overlay Escape hides the panel so the page shows; docked, it gives the manuscript the focus.
    if (overlay) closeTutor()
    else focusManuscript()
  }
  return (
    <aside
      {...{ [TUTOR_PANEL_ATTR]: '' }}
      aria-label="Tutor"
      data-testid="tutor-panel"
      data-overlay={overlay ? 'true' : undefined}
      onKeyDown={onKeyDown}
      style={{ width: overlay ? `min(${PANEL_WIDTH + 20}px, calc(100vw - 3rem))` : PANEL_WIDTH }}
      className={cn(
        'flex min-h-0 shrink-0 flex-col border-l border-border bg-surface-raised text-text',
        overlay ? 'absolute inset-y-0 right-0 z-30 shadow-raised' : 'relative',
      )}
    >
      <div className="flex shrink-0 items-center gap-0.5 border-b border-border px-2 py-1">
        <span className="ml-1 text-accent">
          <SparkleIcon />
        </span>
        <h2 className="flex-1 px-1.5 text-ui font-semibold">Tutor</h2>
        <Tooltip controlId={C.history.id} side="bottom">
          <IconButton
            label={C.history.label}
            data-control-id={C.history.id}
            aria-pressed={view === 'history'}
            onClick={() => showHistory(view !== 'history')}
            className={cn(view === 'history' && 'bg-accent-soft text-accent')}
          >
            <HistoryIcon />
          </IconButton>
        </Tooltip>
        <Tooltip controlId={C.newChat.id} side="bottom">
          <IconButton label={C.newChat.label} data-control-id={C.newChat.id} onClick={() => void newChat()}>
            <NewChatIcon />
          </IconButton>
        </Tooltip>
        <Tooltip controlId={C.close.id} side="bottom">
          <IconButton label={C.close.label} data-control-id={C.close.id} onClick={() => closeTutor()}>
            <CloseIcon />
          </IconButton>
        </Tooltip>
      </div>
      {view === 'history' ? (
        <HistoryList />
      ) : (
        <>
          <MessageList connect={connectProvider} />
          <Composer />
        </>
      )}
    </aside>
  )
}
