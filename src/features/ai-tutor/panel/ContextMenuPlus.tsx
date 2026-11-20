import * as Menu from '@radix-ui/react-dropdown-menu'
import { useState } from 'react'
import { getEditor } from '@/features/editor'
import { useStore } from '@/shared/store'
import { cn, focusRing, IconButton, Tooltip } from '@/shared/ui'
import { attach, currentChapterAttachment, currentPageAttachment, requestComposerFocus, selectionAttachment, useTutorChat } from './chat'
import { TUTOR_CONTROLS as C } from './controls'
import { BookIcon, ChapterIcon, ChevronRightIcon, PageIcon, PlusIcon, SelectionIcon } from './icons'

const formatCount = (n: number) => new Intl.NumberFormat().format(n)
const words = (n: number) => `${formatCount(n)} ${n === 1 ? 'word' : 'words'}`

export const menuContentClass = 'z-40 min-w-60 max-w-[calc(100vw-1rem)] rounded-control border border-border bg-surface-raised p-1 text-text shadow-raised'
export const menuItemClass = cn(
  'relative flex min-h-control-lg cursor-default select-none items-center gap-2.5 rounded-control px-2.5 py-1.5 text-ui-sm outline-hidden',
  'data-[highlighted]:bg-surface-hover data-[disabled]:cursor-not-allowed data-[disabled]:opacity-60',
  focusRing,
)

/**
 * The composer's + menu (design, "+ menu"): Current Page, Current Chapter ▸ (the navigation pane's
 * chapters, with their word counts), Selection (off with a caret) and Whole Manuscript. Each adds a chip;
 * nothing is sent until ➤.
 */
export function ContextMenuPlus() {
  const chapters = useStore((s) => s.wordCount.chapters)
  const busy = useTutorChat((s) => s.busy)
  // What the menu offers is read when it opens (the selection and the page may have moved).
  const [snap, setSnap] = useState({ page: currentPageAttachment(), selection: selectionAttachment(), chapter: currentChapterAttachment() })
  const current = snap.chapter?.kind === 'chapter' ? snap.chapter.chapter : null
  const add = (a: Parameters<typeof attach>[0] | null) => {
    if (a) attach(a)
  }
  return (
    <Menu.Root
      modal={false}
      onOpenChange={(open) => {
        if (open) setSnap({ page: currentPageAttachment(), selection: selectionAttachment(), chapter: currentChapterAttachment() })
      }}
    >
      <Tooltip controlId={C.attach.id} side="top">
        <Menu.Trigger asChild disabled={busy || !getEditor()}>
          <IconButton label={C.attach.label} data-control-id={C.attach.id} className="rounded-full">
            <PlusIcon />
          </IconButton>
        </Menu.Trigger>
      </Tooltip>
      <Menu.Portal>
        <Menu.Content
          side="top"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          className={menuContentClass}
          onCloseAutoFocus={(e) => {
            e.preventDefault()
            requestComposerFocus()
          }}
        >
          <Menu.Label className="px-2.5 pb-0.5 pt-1.5 text-ui-xs font-semibold text-text-muted">Add to your message</Menu.Label>
          <Tooltip controlId={C.attachPage.id} side="right">
            <Menu.Item data-control-id={C.attachPage.id} disabled={!snap.page} className={menuItemClass} onSelect={() => add(snap.page)}>
              <PageIcon />
              <span className="flex-1">Current Page</span>
              {snap.page?.kind === 'page' ? <span className="text-ui-xs text-text-muted">Page {snap.page.page}</span> : null}
            </Menu.Item>
          </Tooltip>
          <Menu.Sub>
            <Tooltip controlId={C.attachChapter.id} side="right">
              <Menu.SubTrigger data-control-id={C.attachChapter.id} disabled={chapters.length === 0} className={menuItemClass}>
                <ChapterIcon />
                <span className="flex-1">Current Chapter</span>
                <ChevronRightIcon />
              </Menu.SubTrigger>
            </Tooltip>
            <Menu.Portal>
              <Menu.SubContent sideOffset={4} collisionPadding={8} className={cn(menuContentClass, 'max-h-[min(24rem,70vh)] overflow-y-auto')}>
                {chapters.map((ch) => {
                  const n = ch.index + 1
                  const title = ch.title.replace(/\s+/g, ' ').trim()
                  const name = title ? `Chapter ${n}: ${title}` : `Chapter ${n}`
                  return (
                    <Tooltip key={ch.index} side="right" copy={{ title: name, description: `${C.attachChapterItem.description} ${words(ch.counts.total.words)}.` }}>
                      <Menu.Item data-control-id={C.attachChapterItem.id} className={menuItemClass} onSelect={() => add({ kind: 'chapter', chapter: n })}>
                        <span className="w-5 shrink-0 text-right font-semibold tabular-nums">{n}</span>
                        <span className="min-w-0 flex-1 truncate">
                          {title || `Chapter ${n}`}
                          {n === current ? <span className="text-text-muted"> (current)</span> : null}
                        </span>
                        <span className="text-ui-xs tabular-nums text-text-muted">{words(ch.counts.total.words)}</span>
                      </Menu.Item>
                    </Tooltip>
                  )
                })}
              </Menu.SubContent>
            </Menu.Portal>
          </Menu.Sub>
          <Tooltip controlId={C.attachSelection.id} side="right">
            <Menu.Item data-control-id={C.attachSelection.id} disabled={!snap.selection} className={menuItemClass} onSelect={() => add(snap.selection)}>
              <SelectionIcon />
              <span className="flex-1">Selection</span>
              {!snap.selection ? <span className="text-ui-xs text-text-muted">Nothing selected</span> : null}
            </Menu.Item>
          </Tooltip>
          <Menu.Separator className="my-1 h-px bg-border" />
          <Tooltip controlId={C.attachManuscript.id} side="right">
            <Menu.Item data-control-id={C.attachManuscript.id} className={menuItemClass} onSelect={() => add({ kind: 'manuscript' })}>
              <BookIcon />
              <span className="flex-1">Whole Manuscript</span>
            </Menu.Item>
          </Tooltip>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  )
}
