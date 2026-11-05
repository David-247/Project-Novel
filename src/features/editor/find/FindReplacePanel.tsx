import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useStore } from '@/shared/store'
import { Button, Checkbox, IconButton, Panel, StatusText, TextInput, Tooltip, cn } from '@/shared/ui'
import { FIND_CONTROLS } from './controls'
import { closeFind, findNext, findPrevious, replaceAll, replaceCurrent, startFindEngine } from './engine'
import { ChevronDownIcon, ChevronUpIcon, CloseIcon } from './icons'
import './find.css'

export const FIND_PANEL_ID = 'novel-find-panel'

export interface FindReplacePanelProps {
  className?: string
}

/**
 * Find & replace panel. Renders nothing while closed (and nothing is scanned). Mod-f works with
 * focus anywhere in the app: inside the editor its own keymap handles it, elsewhere the `find.open`
 * command (editor commands, bound by the shared command registry).
 *
 * Keys: Enter = next, Shift+Enter = previous (find field); Enter = replace (replace field);
 * Escape = close and return focus to the editor.
 */
export function FindReplacePanel({ className }: FindReplacePanelProps) {
  const open = useStore((s) => s.find.open)
  return open ? <OpenPanel className={className} /> : null
}

function statusLabel(query: string, count: number, index: number): string {
  if (query.length === 0) return ''
  if (count === 0) return 'No results'
  return index >= 0 ? `${index + 1} of ${count}` : `${count} found`
}

function OpenPanel({ className }: FindReplacePanelProps) {
  const query = useStore((s) => s.find.query)
  const replacement = useStore((s) => s.find.replacement)
  const caseSensitive = useStore((s) => s.find.caseSensitive)
  const wholeWord = useStore((s) => s.find.wholeWord)
  const matchCount = useStore((s) => s.find.matchCount)
  const currentIndex = useStore((s) => s.find.currentIndex)
  const focusRequest = useStore((s) => s.find.focusRequest)
  const actions = useStore((s) => s.findActions)
  const findRef = useRef<HTMLInputElement>(null)
  // Replace-all summary, shown only until the search (or the doc) changes.
  const [replaced, setReplaced] = useState<{ count: number; key: string } | null>(null)
  const searchKey = `${caseSensitive}|${wholeWord}|${query}`

  useEffect(() => startFindEngine(), [])
  usePanelHeightVar()

  /**
   * Run an action from a panel control. If it leaves no matches, the control that triggered it
   * becomes disabled and would drop keyboard focus to <body>; move focus to the find field instead.
   */
  const act = <T,>(fn: () => T): T => {
    const result = fn()
    const active = document.activeElement
    const inField = active === findRef.current
    if (!inField && (useStore.getState().find.matchCount === 0 || active === document.body || active === null)) {
      findRef.current?.focus({ preventScroll: true })
    }
    return result
  }

  useEffect(() => {
    // preventScroll + setSelectionRange: the panel floats (sticky), so focusing it must never
    // scroll the editor region underneath.
    const input = findRef.current
    if (!input) return
    input.focus({ preventScroll: true })
    input.setSelectionRange(0, input.value.length)
  }, [focusRequest])

  const hasMatches = matchCount > 0
  const status =
    replaced && replaced.key === searchKey && !hasMatches
      ? `Replaced ${replaced.count}`
      : statusLabel(query, matchCount, currentIndex)

  const onPanelKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      closeFind()
    }
  }

  const onFindKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
    e.preventDefault()
    if (e.shiftKey) findPrevious()
    else findNext()
  }

  const onReplaceKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
    e.preventDefault()
    replaceCurrent()
  }

  return (
    <Panel
      id={FIND_PANEL_ID}
      label="Find and replace"
      onKeyDown={onPanelKeyDown}
      className={cn('flex w-full max-w-[36rem] flex-col gap-2', className)}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <Tooltip>
          <TextInput
            ref={findRef}
            aria-label={FIND_CONTROLS.query.label}
            placeholder={FIND_CONTROLS.query.label}
            data-control-id={FIND_CONTROLS.query.id}
            aria-keyshortcuts="Enter Shift+Enter Escape"
            value={query}
            onChange={(e) => actions.setQuery(e.target.value)}
            onKeyDown={onFindKeyDown}
            className="w-auto min-w-[10rem] flex-1"
          />
        </Tooltip>
        <StatusText live className="min-w-[5.5rem] text-center" data-testid="find-status">
          {status}
        </StatusText>
        <div className="flex items-center gap-0.5">
          <Tooltip>
            <IconButton
              label={FIND_CONTROLS.previous.label}
              data-control-id={FIND_CONTROLS.previous.id}
              aria-keyshortcuts="Shift+Enter"
              disabled={!hasMatches}
              onClick={() => act(findPrevious)}
            >
              <ChevronUpIcon />
            </IconButton>
          </Tooltip>
          <Tooltip>
            <IconButton
              label={FIND_CONTROLS.next.label}
              data-control-id={FIND_CONTROLS.next.id}
              aria-keyshortcuts="Enter"
              disabled={!hasMatches}
              onClick={() => act(findNext)}
            >
              <ChevronDownIcon />
            </IconButton>
          </Tooltip>
          <Tooltip>
            <IconButton
              label={FIND_CONTROLS.close.label}
              data-control-id={FIND_CONTROLS.close.id}
              aria-keyshortcuts="Escape"
              onClick={() => closeFind()}
            >
              <CloseIcon />
            </IconButton>
          </Tooltip>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Tooltip>
          <TextInput
            aria-label={FIND_CONTROLS.replacement.label}
            placeholder={FIND_CONTROLS.replacement.label}
            data-control-id={FIND_CONTROLS.replacement.id}
            value={replacement}
            onChange={(e) => actions.setReplacement(e.target.value)}
            onKeyDown={onReplaceKeyDown}
            className="w-auto min-w-[10rem] flex-1"
          />
        </Tooltip>
        <Tooltip>
          <Button aria-label={FIND_CONTROLS.replace.label} data-control-id={FIND_CONTROLS.replace.id} disabled={!hasMatches} onClick={() => act(replaceCurrent)}>
            Replace
          </Button>
        </Tooltip>
        <Tooltip>
          <Button aria-label={FIND_CONTROLS.replaceAll.label} data-control-id={FIND_CONTROLS.replaceAll.id} disabled={!hasMatches} onClick={() => setReplaced({ count: act(replaceAll), key: searchKey })}>
            Replace all
          </Button>
        </Tooltip>
      </div>
      <div className="flex flex-wrap items-center gap-x-4">
        <Tooltip wrap>
          <Checkbox
            label={FIND_CONTROLS.caseSensitive.label}
            aria-label={FIND_CONTROLS.caseSensitive.label}
            data-control-id={FIND_CONTROLS.caseSensitive.id}
            checked={caseSensitive}
            onCheckedChange={actions.setCaseSensitive}
          />
        </Tooltip>
        <Tooltip wrap>
          <Checkbox
            label={FIND_CONTROLS.wholeWord.label}
            aria-label={FIND_CONTROLS.wholeWord.label}
            data-control-id={FIND_CONTROLS.wholeWord.id}
            checked={wholeWord}
            onCheckedChange={actions.setWholeWord}
          />
        </Tooltip>
      </div>
    </Panel>
  )
}

/**
 * While open, publish the panel's height as `--nv-find-panel-height` and set `data-find-open` on
 * <html>, so the writing surface can reserve that much top padding (find.css) and the first lines
 * are never hidden under the floating panel.
 */
function usePanelHeightVar() {
  useLayoutEffect(() => {
    const root = document.documentElement
    const el = document.getElementById(FIND_PANEL_ID)
    const update = () => root.style.setProperty('--nv-find-panel-height', `${el?.offsetHeight ?? 0}px`)
    update()
    root.setAttribute('data-find-open', '')
    const ro = typeof ResizeObserver === 'function' && el ? new ResizeObserver(update) : null
    if (ro && el) ro.observe(el)
    return () => {
      ro?.disconnect()
      root.removeAttribute('data-find-open')
      root.style.removeProperty('--nv-find-panel-height')
    }
  }, [])
}
