import { Button, Tooltip } from '@/shared/ui'
import { answerRead, type ReadView } from './chat'
import { TUTOR_CONTROLS as C } from './controls'

/** "The tutor wants to read Chapter 5. Allow?" inline in the reply (design, Settled point 8). */
export function ReadRequest({ read }: { read: ReadView }) {
  return (
    <div className="flex flex-col gap-2 rounded-panel border border-border-control bg-surface p-2.5" data-testid="tutor-read-request" role="group" aria-label="Read request">
      <p className="text-ui-sm text-text">
        The tutor wants to read <strong className="font-semibold">{read.target}</strong>.
        {read.answer === 'pending' ? ' Allow?' : ''}
      </p>
      {read.answer === 'pending' ? (
        <div className="flex gap-1.5">
          <Tooltip controlId={C.readAllow.id}>
            <Button variant="primary" data-control-id={C.readAllow.id} onClick={() => answerRead(read.id, true)}>
              Allow
            </Button>
          </Tooltip>
          <Tooltip controlId={C.readDeny.id}>
            <Button variant="secondary" data-control-id={C.readDeny.id} onClick={() => answerRead(read.id, false)}>
              Don&apos;t Allow
            </Button>
          </Tooltip>
        </div>
      ) : (
        <p className="text-ui-xs font-medium text-text-muted" role="status">
          {read.answer === 'allowed' ? 'Allowed for this question.' : 'Not allowed.'}
        </p>
      )}
    </div>
  )
}
