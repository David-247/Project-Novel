import * as RToolbar from '@radix-ui/react-toolbar'
import type { ChainedCommands } from '@tiptap/core'
import { Fragment } from 'react'
import type { KeyboardEvent, MouseEvent, ReactElement, ReactNode } from 'react'
import { cn, Select, ToggleButton, IconButton, ToolbarGroup, ToolbarSeparator } from '@/shared/ui'
import { listSystemFonts } from '../fonts'
import { TOOLBAR_CONTROLS } from './controls'
import type { ToolbarControlKey } from './controls'
import { FontFamilyPicker } from './FontFamilyPicker'
import * as I from './icons'
import { FONT_SIZES, LINE_SPACINGS, PARAGRAPH_SPACINGS, withCurrent } from './presets'
import type { Alignment } from './toolbar-state'
import { useMountedEditor } from './use-mounted-editor'
import { useToolbarState } from './use-toolbar-state'

export interface ToolbarProps {
  /** Rendered before the built-in groups (e.g. undo/redo). Wrap focusable items in `ToolbarItem`. */
  leadingGroups?: ReactNode
  /** Rendered after the built-in groups (e.g. find). Wrap focusable items in `ToolbarItem`. */
  extraGroups?: ReactNode
  /** Font list source for the font family control (stable reference); defaults to the OS fonts. */
  loadFonts?: () => Promise<string[]>
  className?: string
}

/**
 * Makes one focusable control part of the toolbar's roving focus (arrow keys move between
 * items; Tab enters/leaves the toolbar). The child must spread unknown props and `ref`
 * onto its focusable element (all `@/shared/ui` controls do).
 */
export function ToolbarItem({ children, disabled }: { children: ReactElement; disabled?: boolean }) {
  return (
    <RToolbar.Button asChild type={undefined} disabled={disabled}>
      {children}
    </RToolbar.Button>
  )
}

/** Pointer activation returns focus to the text; keyboard activation keeps it in the toolbar. */
function chainFrom(chain: ChainedCommands, e: MouseEvent): ChainedCommands {
  return e.detail > 0 ? chain.focus() : chain
}

const ALIGNMENTS: ReadonlyArray<{ key: ToolbarControlKey; value: Alignment; icon: () => ReactElement }> = [
  { key: 'alignLeft', value: 'left', icon: I.AlignLeftIcon },
  { key: 'alignCenter', value: 'center', icon: I.AlignCenterIcon },
  { key: 'alignRight', value: 'right', icon: I.AlignRightIcon },
  { key: 'alignJustify', value: 'justify', icon: I.AlignJustifyIcon },
]

/**
 * Formatting toolbar (ARIA `toolbar` with roving focus). Active states come from
 * `useToolbarState`, which reads only the selection (see `readToolbarState`).
 */
export function Toolbar({ leadingGroups, extraGroups, loadFonts = listSystemFonts, className }: ToolbarProps) {
  const editor = useMountedEditor()
  const s = useToolbarState(editor)
  const disabled = !editor || !s.ready

  const toggle = (key: ToolbarControlKey, pressed: boolean, run: (c: ChainedCommands) => ChainedCommands, icon: ReactElement) => {
    const meta = TOOLBAR_CONTROLS[key]
    return (
      <ToolbarItem disabled={disabled}>
        <ToggleButton
          label={meta.label}
          data-control-id={meta.id}
          pressed={pressed}
          disabled={disabled}
          onPressedChange={() => {}}
          onClick={(e) => {
            e.preventDefault()
            if (editor) run(chainFrom(editor.chain(), e)).run()
          }}
        >
          {icon}
        </ToggleButton>
      </ToolbarItem>
    )
  }

  const action = (key: ToolbarControlKey, enabled: boolean, run: (c: ChainedCommands) => ChainedCommands, icon: ReactElement) => {
    const meta = TOOLBAR_CONTROLS[key]
    return (
      <ToolbarItem disabled={disabled || !enabled}>
        <IconButton
          label={meta.label}
          data-control-id={meta.id}
          disabled={disabled || !enabled}
          onClick={(e) => {
            if (editor) run(chainFrom(editor.chain(), e)).run()
          }}
        >
          {icon}
        </IconButton>
      </ToolbarItem>
    )
  }

  const select = (key: ToolbarControlKey, value: string, presets: Parameters<typeof withCurrent>[0], apply: (v: string) => void, width: string) => {
    const meta = TOOLBAR_CONTROLS[key]
    return (
      <ToolbarItem disabled={disabled}>
        <Select
          aria-label={meta.label}
          data-control-id={meta.id}
          className={width}
          options={withCurrent(presets, value)}
          value={value}
          disabled={disabled}
          onChange={(e) => apply(e.target.value)}
        />
      </ToolbarItem>
    )
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && editor) {
      e.preventDefault()
      editor.commands.focus()
    }
  }

  return (
    <RToolbar.Root
      aria-label="Formatting"
      className={cn('flex min-w-0 flex-1 flex-wrap items-center gap-x-1 gap-y-1', className)}
      onKeyDown={onKeyDown}
    >
      {leadingGroups ? (
        <>
          {leadingGroups}
          <ToolbarSeparator />
        </>
      ) : null}

      <ToolbarGroup label="Font" className="gap-1">
        <ToolbarItem disabled={disabled}>
          <FontFamilyPicker loadFonts={loadFonts} disabled={disabled} />
        </ToolbarItem>
        {select('fontSize', s.fontSize, FONT_SIZES, (v) => {
          if (!editor) return
          if (v) editor.chain().setFontSize(v).run()
          else editor.chain().unsetFontSize().run()
        }, 'w-32')}
      </ToolbarGroup>
      <ToolbarSeparator />

      <ToolbarGroup label="Text style">
        {toggle('bold', s.bold, (c) => c.toggleBold(), <I.BoldIcon />)}
        {toggle('italic', s.italic, (c) => c.toggleItalic(), <I.ItalicIcon />)}
        {toggle('underline', s.underline, (c) => c.toggleUnderline(), <I.UnderlineIcon />)}
      </ToolbarGroup>
      <ToolbarSeparator />

      <ToolbarGroup label="Lists">
        {toggle('bulletList', s.bulletList, (c) => c.toggleBulletList(), <I.BulletListIcon />)}
        {toggle('orderedList', s.orderedList, (c) => c.toggleOrderedList(), <I.OrderedListIcon />)}
      </ToolbarGroup>
      <ToolbarSeparator />

      <ToolbarGroup label="Alignment">
        {ALIGNMENTS.map(({ key, value, icon: Icon }) => (
          <Fragment key={key}>
            {toggle(key, s.align === value, (c) => (value === 'left' ? c.unsetTextAlign() : c.setTextAlign(value)), <Icon />)}
          </Fragment>
        ))}
      </ToolbarGroup>
      <ToolbarSeparator />

      <ToolbarGroup label="Spacing and indent" className="gap-1">
        {select('lineSpacing', s.lineHeight, LINE_SPACINGS, (v) => editor?.chain().setBlockLineHeight(v || null).run(), 'w-32')}
        {select('paragraphSpacing', s.paragraphSpacing, PARAGRAPH_SPACINGS, (v) => editor?.chain().setBlockSpacing(v || null).run(), 'w-36')}
        {action('indentDecrease', s.canOutdent, (c) => c.outdentBlock(), <I.IndentDecreaseIcon />)}
        {action('indentIncrease', s.canIndent, (c) => c.indentBlock(), <I.IndentIncreaseIcon />)}
      </ToolbarGroup>

      {extraGroups ? (
        <>
          <ToolbarSeparator />
          {extraGroups}
        </>
      ) : null}
    </RToolbar.Root>
  )
}
