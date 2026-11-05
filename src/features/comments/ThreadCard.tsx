import { memo, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { useStore } from '@/shared/store'
import { Button, cn, fieldBase, IconButton, Tooltip } from '@/shared/ui'
import { cancelDraft, deleteMessage, deleteThread, editMessage, goToThread, reopenThread, replyToThread, resolveThread, submitDraft } from './commands'
import { COMMENT_CONTROLS as C } from './controls'
import { currentAuthor, getCommentsView } from './extension'
import { CheckIcon, JumpIcon, PencilIcon, ReopenIcon, TrashIcon } from './icons'
import { relativeDate, type CommentThread } from './model'

const setActive = (id: string | null) => useStore.getState().commentsActions.setActive(id)
const setHover = (id: string | null) => useStore.getState().commentsActions.setHover(id)

const isSubmit = (e: KeyboardEvent) => e.key === 'Enter' && (e.metaKey || e.ctrlKey)

/** Multi-line plain-text field (line breaks kept). Mod-Enter submits, Escape cancels. */
function TextField({
  controlId,
  label,
  value,
  onChange,
  onSubmit,
  onCancel,
  autoFocus,
  focusKey,
}: {
  controlId: string
  label: string
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  onCancel: () => void
  autoFocus?: boolean
  /** Changing it focuses the field again. */
  focusKey?: number
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (autoFocus) ref.current?.focus({ preventScroll: true })
  }, [autoFocus, focusKey])
  return (
    <Tooltip side="left">
      <textarea
        ref={ref}
        data-control-id={controlId}
        aria-label={label}
        rows={2}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (isSubmit(e)) {
            e.preventDefault()
            onSubmit()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            onCancel()
          }
        }}
        className={cn(fieldBase, 'block w-full resize-y whitespace-pre-wrap py-1.5 leading-snug')}
      />
    </Tooltip>
  )
}

function CardButton({ meta, onClick, children, variant = 'ghost', disabled }: { meta: (typeof C)[keyof typeof C]; onClick: () => void; children: ReactNode; variant?: 'ghost' | 'primary' | 'secondary'; disabled?: boolean }) {
  return (
    <Tooltip side="bottom">
      <Button variant={variant} data-control-id={meta.id} onClick={onClick} disabled={disabled}>
        {children}
      </Button>
    </Tooltip>
  )
}

function CardIconButton({ meta, onClick, children }: { meta: (typeof C)[keyof typeof C]; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip side="bottom">
      <IconButton label={meta.label} data-control-id={meta.id} onClick={onClick}>
        {children}
      </IconButton>
    </Tooltip>
  )
}

function Dot({ color }: { color?: string | null }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block size-2.5 shrink-0 rounded-full border border-border-control"
      style={{ background: color ?? 'var(--page-comment-active-bg)' }}
    />
  )
}

const cardBase = 'nv-comment-card block w-full rounded-panel border bg-surface-raised p-3 text-left text-ui-sm text-text shadow-raised'

export interface ThreadCardProps {
  thread: CommentThread
  active: boolean
  lit: boolean
}

/**
 * One thread: author, colour dot, relative date and messages, then Reply, Resolve / Reopen and Delete.
 * Focusing or hovering the card highlights its anchor text (and the caret in the anchor selects the
 * card): never hover alone.
 */
export const ThreadCard = memo(function ThreadCard({ thread, active, lit }: ThreadCardProps) {
  const [replying, setReplying] = useState(false)
  const [reply, setReply] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const me = currentAuthor().name

  const sendReply = () => {
    if (replyToThread(thread.id, reply)) {
      setReply('')
      setReplying(false)
    }
  }
  const saveEdit = () => {
    if (editing && (editMessage(thread.id, editing, editText) || editText.trim())) setEditing(null)
  }

  return (
    <article
      tabIndex={0}
      aria-label={`Comment by ${thread.author}${thread.resolved ? ' (resolved)' : ''}`}
      aria-current={active || undefined}
      data-thread-id={thread.id}
      data-active={active || undefined}
      data-resolved={thread.resolved || undefined}
      onFocus={() => {
        if (!active) setActive(thread.id)
      }}
      onMouseDown={() => {
        if (!active) setActive(thread.id)
      }}
      onMouseEnter={() => setHover(thread.id)}
      onMouseLeave={() => setHover(null)}
      className={cn(cardBase, active ? 'border-accent ring-1 ring-accent' : lit ? 'border-border-control' : 'border-border', thread.resolved && 'opacity-90')}
    >
      <ol className="space-y-2">
        {thread.messages.map((m, i) => (
          <li key={m.id} data-message-id={m.id}>
            <div className="flex items-center gap-1.5">
              <Dot color={i === 0 ? thread.authorColor : null} />
              <span className="min-w-0 truncate font-semibold">{m.author || 'Unknown'}</span>
              <span className="shrink-0 text-ui-xs text-text-muted" title={new Date(m.date).toLocaleString()}>
                {relativeDate(m.date)}
                {m.editedAt ? ' · edited' : ''}
              </span>
              <span className="flex-1" />
              {m.author === me && editing !== m.id ? (
                <CardIconButton
                  meta={C.edit}
                  onClick={() => {
                    setEditing(m.id)
                    setEditText(m.text)
                  }}
                >
                  <PencilIcon />
                </CardIconButton>
              ) : null}
              {i > 0 ? (
                <CardIconButton meta={C.deleteMessage} onClick={() => deleteMessage(thread.id, m.id)}>
                  <TrashIcon />
                </CardIconButton>
              ) : null}
            </div>
            {editing === m.id ? (
              <div className="mt-1 space-y-1.5">
                <TextField controlId={C.editField.id} label={C.editField.label} value={editText} onChange={setEditText} onSubmit={saveEdit} onCancel={() => setEditing(null)} autoFocus />
                <div className="flex justify-end gap-1.5">
                  <CardButton meta={C.editCancel} onClick={() => setEditing(null)}>
                    {C.editCancel.label}
                  </CardButton>
                  <CardButton meta={C.editSave} variant="primary" onClick={saveEdit}>
                    {C.editSave.label}
                  </CardButton>
                </div>
              </div>
            ) : (
              <p className="mt-0.5 whitespace-pre-wrap break-words" data-testid="comment-text">
                {m.text}
              </p>
            )}
          </li>
        ))}
      </ol>
      {thread.resolved ? (
        <p className="mt-2 text-ui-xs text-text-muted">Resolved{thread.resolvedBy ? ` by ${thread.resolvedBy}` : ''}</p>
      ) : null}
      {replying ? (
        <div className="mt-2 space-y-1.5">
          <TextField controlId={C.replyField.id} label={C.replyField.label} value={reply} onChange={setReply} onSubmit={sendReply} onCancel={() => setReplying(false)} autoFocus />
          <div className="flex justify-end gap-1.5">
            <CardButton meta={C.replyCancel} onClick={() => setReplying(false)}>
              Cancel
            </CardButton>
            <CardButton meta={C.reply} variant="primary" onClick={sendReply} disabled={!reply.trim()}>
              Reply
            </CardButton>
          </div>
        </div>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-1">
        {!replying ? (
          <CardButton
            meta={C.replyStart}
            onClick={() => {
              setActive(thread.id)
              setReplying(true)
            }}
          >
            {C.replyStart.label}
          </CardButton>
        ) : null}
        {thread.resolved ? (
          <CardButton meta={C.reopen} onClick={() => reopenThread(thread.id)}>
            <ReopenIcon />
            {C.reopen.label}
          </CardButton>
        ) : (
          <CardButton meta={C.resolve} onClick={() => resolveThread(thread.id)}>
            <CheckIcon />
            {C.resolve.label}
          </CardButton>
        )}
        <span className="flex-1" />
        <CardIconButton meta={C.jump} onClick={() => goToThread(thread.id, { focus: true })}>
          <JumpIcon />
        </CardIconButton>
        <CardIconButton meta={C.delete} onClick={() => deleteThread(thread.id)}>
          <TrashIcon />
        </CardIconButton>
      </div>
    </article>
  )
})

/** The New Comment composer, shown at the selection until it is submitted or cancelled. */
export function DraftCard() {
  const [text, setText] = useState('')
  const focusKey = useStore((s) => s.comments.composeRequest)
  const author = currentAuthor()
  // Keyboard users go back to writing where they were.
  const backToText = () => getCommentsView()?.focus()
  const submit = () => {
    if (submitDraft(text)) {
      setText('')
      backToText()
    }
  }
  const cancel = () => {
    cancelDraft()
    backToText()
  }
  return (
    <article aria-label="New comment" data-thread-id="draft" className={cn(cardBase, 'border-accent ring-1 ring-accent')}>
      <div className="mb-1.5 flex items-center gap-1.5">
        <Dot color={author.color} />
        <span className="font-semibold">{author.name}</span>
      </div>
      <TextField controlId={C.composeField.id} label={C.composeField.label} value={text} onChange={setText} onSubmit={submit} onCancel={cancel} autoFocus focusKey={focusKey} />
      <div className="mt-1.5 flex justify-end gap-1.5">
        <CardButton meta={C.composeCancel} onClick={cancel}>
          {C.composeCancel.label}
        </CardButton>
        <CardButton meta={C.composeSubmit} variant="primary" onClick={submit} disabled={!text.trim()}>
          {C.composeSubmit.label}
        </CardButton>
      </div>
    </article>
  )
}
