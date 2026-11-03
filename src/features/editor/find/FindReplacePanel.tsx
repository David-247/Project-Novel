import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useStore } from '@/shared/store'
import { Button, Checkbox, IconButton, Panel, StatusText, TextInput, cn } from '@/shared/ui'
import { closeFind, findNext, findPrevious, openFind, replaceAll, replaceCurrent, startFindEngine } from './engine'
import { ChevronDownIcon, ChevronUpIcon, CloseIcon } from './icons'
import { IS_MAC } from './use-editor-instance'
import './find.css'

export const FIND_PANEL_ID = 'novel-find-panel'

export interface FindReplacePanelProps {
  className?: string
}

function isModF(e: KeyboardEvent): boolean {
  const mod = IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  return mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f'
}

/**
 * Find & replace panel. Renders nothing while closed (and nothing is scanned), but always
 * listens for Mod-f at window level so the shortcut works with focus anywhere in the app
 * (inside the editor, the editor's own Mod-f keymap handles it first).
 *
 * Keys: Enter = next, Shift+Enter = previous (find field); Enter = replace (replace field);
 * Escape = close and return focus to the editor.
 */
export function FindReplacePanel({ className }: FindReplacePanelProps) {
  const open = useStore((s) => s.find.open)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !isModF(e)) return
      e.preventDefault()
      openFind()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

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

  useEffect(() => {
    findRef.current?.focus()
    findRef.current?.select()
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
        <TextInput
          ref={findRef}
          aria-label="Find"
          placeholder="Find"
          data-control-id="find.query"
          aria-keyshortcuts="Enter Shift+Enter Escape"
          value={query}
          onChange={(e) => actions.setQuery(e.target.value)}
          onKeyDown={onFindKeyDown}
          className="w-auto min-w-[10rem] flex-1"
        />
        <StatusText live className="min-w-[5.5rem] text-center" data-testid="find-status">
          {status}
        </StatusText>
        <div className="flex items-center gap-0.5">
          <IconButton
            label="Previous match"
            data-control-id="find.previous"
            aria-keyshortcuts="Shift+Enter"
            disabled={!hasMatches}
            onClick={findPrevious}
          >
            <ChevronUpIcon />
          </IconButton>
          <IconButton
            label="Next match"
            data-control-id="find.next"
            aria-keyshortcuts="Enter"
            disabled={!hasMatches}
            onClick={findNext}
          >
            <ChevronDownIcon />
          </IconButton>
          <IconButton
            label="Close find and replace"
            data-control-id="find.close"
            aria-keyshortcuts="Escape"
            onClick={() => closeFind()}
          >
            <CloseIcon />
          </IconButton>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <TextInput
          aria-label="Replace with"
          placeholder="Replace with"
          data-control-id="find.replacement"
          value={replacement}
          onChange={(e) => actions.setReplacement(e.target.value)}
          onKeyDown={onReplaceKeyDown}
          className="w-auto min-w-[10rem] flex-1"
        />
        <Button aria-label="Replace" data-control-id="find.replace" disabled={!hasMatches} onClick={() => replaceCurrent()}>
          Replace
        </Button>
        <Button aria-label="Replace all" data-control-id="find.replaceAll" disabled={!hasMatches} onClick={() => setReplaced({ count: replaceAll(), key: searchKey })}>
          Replace all
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-x-4">
        <Checkbox
          label="Match case"
          aria-label="Match case"
          data-control-id="find.caseSensitive"
          checked={caseSensitive}
          onCheckedChange={actions.setCaseSensitive}
        />
        <Checkbox
          label="Whole word"
          aria-label="Whole word"
          data-control-id="find.wholeWord"
          checked={wholeWord}
          onCheckedChange={actions.setWholeWord}
        />
      </div>
    </Panel>
  )
}
