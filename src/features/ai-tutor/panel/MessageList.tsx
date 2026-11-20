import { useLayoutEffect, useRef } from 'react'
import { Button, cn, Tooltip } from '@/shared/ui'
import { openProposalView, retry, useTutorChat, type ProposalView, type ReplyView, type UserMessageView } from './chat'
import { TUTOR_CONTROLS as C } from './controls'
import { CorrectionList } from './CorrectionList'
import { CompareIcon, RetryIcon, SparkleIcon, WarningIcon } from './icons'
import { Markdown } from './markdown'
import { ReadRequest } from './ReadRequest'
import { Greeting } from './SuggestedPrompts'

const formatCount = (n: number) => new Intl.NumberFormat().format(n)

function UserMessage({ m }: { m: UserMessageView }) {
  return (
    <div className="flex flex-col items-end gap-1" data-testid="tutor-user-message">
      {m.chips.length ? (
        <ul className="flex flex-wrap justify-end gap-1" aria-label="Attached">
          {m.chips.map((c, i) => (
            <li key={i} className="rounded-full border border-border bg-surface px-2 py-0.5 text-ui-xs text-text-muted">
              {c.label}
              {c.words ? ` · ${formatCount(c.words)} ${c.words === 1 ? 'word' : 'words'}` : ''}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-panel rounded-br-sm bg-accent-soft px-3 py-2 text-ui text-text">{m.text}</p>
    </div>
  )
}

function Proposal({ p }: { p: ProposalView }) {
  const { change } = p
  return (
    <div className="flex flex-col gap-2 rounded-panel border border-border bg-surface p-2.5" data-testid="tutor-proposal">
      <p className="text-ui-xs font-semibold uppercase tracking-wide text-text-muted">Suggested change</p>
      <p className="text-ui-sm text-text">{change.reason}</p>
      <blockquote className="max-h-32 overflow-y-auto border-l-2 border-border-control pl-2 text-ui-sm text-text-muted">
        {change.revisedText.map((t, i) => (
          <p key={i} className="whitespace-pre-wrap">
            {t}
          </p>
        ))}
      </blockquote>
      {p.status === 'opened' ? (
        <p className="text-ui-xs text-text-muted" role="status">
          Open in the re-write view as “Tutor suggestion”: keep your original or the suggestion there.
        </p>
      ) : (
        <>
          {p.note ? (
            <p className="text-ui-xs text-text-muted" role="status">
              {p.note}
            </p>
          ) : null}
          <div>
            <Tooltip controlId={C.proposalOpen.id}>
              <Button variant="secondary" data-control-id={C.proposalOpen.id} onClick={() => openProposalView(p.id)}>
                <CompareIcon />
                Compare Side by Side
              </Button>
            </Tooltip>
          </div>
        </>
      )}
    </div>
  )
}

function Activity({ text }: { text: string }) {
  return (
    <p className="flex items-center gap-2 text-ui-xs text-text-muted" role="status" data-testid="tutor-activity">
      <span className="nv-tutor-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      {text}
    </p>
  )
}

function Reply({ r, connect }: { r: ReplyView; connect: () => void }) {
  const empty = r.parts.length === 0
  return (
    <div className="flex gap-2.5" data-testid="tutor-reply" data-streaming={r.streaming ? 'true' : undefined} data-incomplete={r.incomplete ? 'true' : undefined}>
      <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent" aria-hidden="true">
        <SparkleIcon className="size-3.5" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        <span className="sr-only">Tutor:</span>
        {r.parts.map((p, i) => {
          switch (p.kind) {
            case 'text':
              return <Markdown key={i} source={p.text} />
            case 'corrections':
              return <CorrectionList key={i} items={p.items} />
            case 'proposal':
              return <Proposal key={i} p={p.proposal} />
            case 'read':
              return <ReadRequest key={i} read={p.read} />
          }
        })}
        {r.streaming && (r.activity || empty) ? <Activity text={r.activity ?? 'Thinking…'} /> : null}
        {r.scripted === 'not-connected' ? (
          <div>
            <Tooltip controlId={C.connect.id}>
              <Button variant="primary" data-control-id={C.connect.id} onClick={connect}>
                Connect a Provider…
              </Button>
            </Tooltip>
          </div>
        ) : null}
        {r.error ? (
          <div className="flex flex-col gap-2 rounded-panel border border-danger/50 bg-surface p-2.5" role="alert" data-testid="tutor-error">
            <p className="flex items-start gap-1.5 text-ui-sm text-text">
              <span className="mt-0.5 text-danger">
                <WarningIcon />
              </span>
              {r.error.message}
            </p>
            {r.canRetry ? (
              <div>
                <Tooltip controlId={C.retry.id}>
                  <Button variant="secondary" data-control-id={C.retry.id} onClick={() => void retry()}>
                    <RetryIcon />
                    Retry
                  </Button>
                </Tooltip>
              </div>
            ) : null}
          </div>
        ) : null}
        {!r.streaming && r.incomplete && !r.scripted ? (
          <p className="text-ui-xs italic text-text-muted" data-testid="tutor-incomplete">
            {r.stopped ? 'Stopped. This reply is incomplete.' : 'This reply is incomplete.'}
          </p>
        ) : null}
      </div>
    </div>
  )
}

/** The conversation: the greeting and suggested prompts on a new chat, then the messages and replies. */
export function MessageList({ connect }: { connect: () => void }) {
  const messages = useTutorChat((s) => s.messages)
  const ref = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  // Follow the reply as it streams, unless the writer scrolled up to read.
  useLayoutEffect(() => {
    const el = ref.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [messages])
  return (
    <div
      ref={ref}
      role="log"
      aria-label="Conversation"
      onScroll={(e) => {
        const el = e.currentTarget
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
      }}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
    >
      {messages.length === 0 ? (
        <Greeting />
      ) : (
        <div className={cn('flex flex-col gap-4 px-3 py-4')}>
          {messages.map((m) => (m.role === 'user' ? <UserMessage key={m.id} m={m} /> : <Reply key={m.id} r={m} connect={connect} />))}
        </div>
      )}
    </div>
  )
}
