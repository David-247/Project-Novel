import * as Menu from '@radix-ui/react-dropdown-menu'
import { NodeSelection } from '@tiptap/pm/state'
import { useRef, useState } from 'react'
import type { Ref } from 'react'
import { Button, cn, focusRing, formatShortcut, detectPlatform, Tooltip } from '@/shared/ui'
import { getEditor } from '../controller'
import { getFootnoteEditing } from '../footnote/editing'
import { setChaptersStartOn, type ChaptersStartOn } from './chapter-start'
import { CHAPTER_START_CONTROLS, INSERT_ITEMS, INSERT_MENU_CONTROL, ORNAMENT_CONTROLS } from './controls'
import { getNewSceneBreakOrnament, setNewSceneBreakOrnament } from './nodes'
import { useResolvedStyles } from '../styles/resolved'
import { STYLE_IDS } from '@/shared/book'

export interface InsertMenuProps {
  /** Visible name and accessible name of the trigger (default "Insert"). */
  label?: string
  /** Props from an asChild parent (a toolbar item) land on the trigger button. */
  [prop: string]: unknown
  ref?: Ref<HTMLButtonElement>
}

const itemClass = cn(
  'relative flex min-h-control-lg cursor-default select-none items-center gap-3 rounded-control py-1.5 pl-7 pr-2.5',
  'text-ui-sm data-[highlighted]:bg-surface-hover',
  focusRing,
)
const labelClass = 'px-2.5 pb-0.5 pt-1.5 text-ui-xs font-semibold text-text-muted'

function Check() {
  return (
    <Menu.ItemIndicator className="absolute left-2 inline-flex items-center">
      <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4">
        <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </Menu.ItemIndicator>
  )
}

/**
 * Insert menu (toolbar `insert.menu`): Page break, New chapter and Scene break (the items of
 * `INSERT_ITEMS`), then the book setting "Chapters start on" and the scene break ornament as radio
 * groups. Radix dropdown like the trim size picker: Enter/Space/ArrowDown opens, arrows move, Enter
 * selects, Escape closes and returns focus to the button. Rows are 40px tall for touch. The ornament
 * applies to the selected scene break, if one is selected, and to scene breaks inserted afterwards.
 */
export function InsertMenu({ ref, label = INSERT_MENU_CONTROL.label, ...forwarded }: InsertMenuProps) {
  const styles = useResolvedStyles()
  const chaptersStartOn: ChaptersStartOn = styles.get(STYLE_IDS.chapterTitle)?.breakBefore === 'recto' ? 'recto' : 'page'
  const [ornament, setOrnament] = useState(getNewSceneBreakOrnament)
  const inserted = useRef(false)
  const platform = detectPlatform()

  const chooseOrnament = (value: string) => {
    setNewSceneBreakOrnament(value)
    setOrnament(value)
    const ed = getEditor()
    if (ed && ed.state.selection instanceof NodeSelection && ed.state.selection.node.type.name === 'sceneBreak') {
      ed.chain().focus().setSceneBreakOrnament(value).run()
    }
  }

  return (
    <Menu.Root modal={false}>
      <Tooltip controlId={INSERT_MENU_CONTROL.id} {...forwarded} ref={ref as Ref<HTMLElement>}>
        <Menu.Trigger asChild>
          <Button variant="ghost" data-control-id={INSERT_MENU_CONTROL.id} aria-label={label} className="gap-2">
            <span>{label}</span>
            <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4 text-text-muted">
              <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Button>
        </Menu.Trigger>
      </Tooltip>
      <Menu.Portal>
        <Menu.Content
          align="start"
          sideOffset={6}
          collisionPadding={8}
          // After an insert the caret stays in the manuscript; otherwise focus returns to the button.
          onCloseAutoFocus={(e) => {
            if (!inserted.current) return
            inserted.current = false
            e.preventDefault()
            // An inserted footnote has its own editor, which holds the focus.
            if (!getFootnoteEditing()) getEditor()?.commands.focus()
          }}
          className="z-40 min-w-64 max-w-[calc(100vw-1rem)] rounded-control border border-border bg-surface-raised p-1 text-text shadow-raised"
        >
          {INSERT_ITEMS.map((item) => (
            <Tooltip key={item.id} side="right" controlId={item.id}>
              <Menu.Item
                data-control-id={item.id}
                className={cn(itemClass, 'pl-2.5')}
                onSelect={() => {
                  const ed = getEditor()
                  inserted.current = Boolean(ed)
                  if (ed) item.run(ed)
                }}
              >
                <span className="flex-1 font-medium">{item.label}</span>
                {item.shortcut && (
                  <span className="text-text-muted">
                    {[item.shortcut].flat().map((s) => formatShortcut(s, platform)).join(' ')}
                  </span>
                )}
              </Menu.Item>
            </Tooltip>
          ))}
          <Menu.Separator className="my-1 h-px bg-border" />
          <Menu.Group aria-label="Chapters start on">
            <Menu.Label className={labelClass}>Chapters start on</Menu.Label>
            <Menu.RadioGroup value={chaptersStartOn} onValueChange={(v) => setChaptersStartOn(v as ChaptersStartOn)}>
              {CHAPTER_START_CONTROLS.map((c) => (
                <Tooltip key={c.id} side="right" controlId={c.id}>
                  <Menu.RadioItem value={c.value} data-control-id={c.id} className={itemClass}>
                    <Check />
                    <span className="flex-1">{c.label}</span>
                  </Menu.RadioItem>
                </Tooltip>
              ))}
            </Menu.RadioGroup>
          </Menu.Group>
          <Menu.Separator className="my-1 h-px bg-border" />
          <Menu.Group aria-label="Scene break ornament">
            <Menu.Label className={labelClass}>Scene break ornament</Menu.Label>
            <Menu.RadioGroup value={ornament} onValueChange={chooseOrnament}>
              {ORNAMENT_CONTROLS.map((c) => (
                <Tooltip key={c.id} side="right" controlId={c.id}>
                  <Menu.RadioItem value={c.value} data-control-id={c.id} className={itemClass}>
                    <Check />
                    <span className="flex-1">{c.label}</span>
                  </Menu.RadioItem>
                </Tooltip>
              ))}
            </Menu.RadioGroup>
          </Menu.Group>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  )
}
