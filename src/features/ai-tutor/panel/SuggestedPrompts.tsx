import { cn, focusRing, Tooltip } from '@/shared/ui'
import { scriptedReply } from '../harness/assemble'
import { askCapabilities, currentChapterAttachment, currentPageAttachment, sendPrompt, useTutorChat } from './chat'
import { TUTOR_CONTROLS as C } from './controls'
import { ChapterIcon, PageIcon, SparkleIcon } from './icons'

interface Prompt {
  text: string
  description: string
  icon: () => React.ReactElement
  run: () => void
}

const PROMPTS: Prompt[] = [
  {
    text: 'What can you do?',
    description: 'See what the tutor helps with.',
    icon: () => <SparkleIcon />,
    run: () => askCapabilities(),
  },
  {
    text: 'Help me format my chapter',
    description: 'Send the chapter you are in and ask about formatting it.',
    icon: () => <ChapterIcon />,
    run: () => void sendPrompt('Help me format my chapter.', 'format', currentChapterAttachment() ?? currentPageAttachment()),
  },
  {
    text: 'Check my grammar',
    description: 'Send the page you are on for a proofread, with a list of fixes to review.',
    icon: () => <PageIcon />,
    run: () => void sendPrompt('Check my grammar.', 'proofread', currentPageAttachment()),
  },
]

/** The opening: the greeting (scripted, no AI call) and three suggested prompts (design, "Chat panel"). */
export function Greeting() {
  const busy = useTutorChat((s) => s.busy)
  return (
    <div className="flex flex-col gap-4 px-4 pt-6 pb-2" data-testid="tutor-greeting">
      <div className="flex flex-col items-start gap-3">
        <span className="inline-flex size-10 items-center justify-center rounded-full bg-accent-soft text-accent">
          <SparkleIcon className="size-5" />
        </span>
        <p className="text-ui-lg font-semibold text-text">{scriptedReply('greeting')}</p>
      </div>
      <ul className="flex flex-col gap-2" aria-label="Suggested prompts">
        {PROMPTS.map((p) => (
          <li key={p.text}>
            <Tooltip copy={{ title: p.text, description: `${p.description} ${C.prompt.description}` }} side="left">
              <button
                type="button"
                data-control-id={C.prompt.id}
                disabled={busy}
                onClick={p.run}
                className={cn(
                  'flex min-h-control-lg w-full items-center gap-2.5 rounded-panel border border-border bg-surface px-3 py-2 text-left text-ui-sm text-text',
                  'transition-colors duration-100 hover:border-border-control hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50',
                  focusRing,
                )}
              >
                <span className="text-accent">{p.icon()}</span>
                <span className="flex-1">{p.text}</span>
              </button>
            </Tooltip>
          </li>
        ))}
      </ul>
    </div>
  )
}
