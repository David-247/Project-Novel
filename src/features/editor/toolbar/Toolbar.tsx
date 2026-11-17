import * as RToolbar from '@radix-ui/react-toolbar'
import type { ChainedCommands } from '@tiptap/core'
import { Fragment } from 'react'
import type { KeyboardEvent, MouseEvent, ReactElement, ReactNode } from 'react'
import { cn, Select, ToggleButton, IconButton, ToolbarGroup, ToolbarSeparator, Tooltip } from '@/shared/ui'
import { loadSystemFonts } from '../fonts'
import { TOOLBAR_CONTROLS } from './controls'
import type { ToolbarControlKey } from './controls'
import { FontFamilyPicker } from './FontFamilyPicker'
import { markChain } from './mark-chain'
import * as I from './icons'
import { FIRST_LINE_INDENTS, FONT_SIZES, LINE_SPACINGS, PARAGRAPH_SPACINGS, withCurrent } from './presets'
import type { Alignment } from './toolbar-state'
import { useActiveEditor } from '../use-mounted-editor'
import { useToolbarState } from './use-toolbar-state'
import { StylesGroup } from '../styles/StylesGroup'

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
/**
 * A pointer press on a formatting button must not take focus from the manuscript. Otherwise the
 * button holds focus until the command's deferred editor focus (next animation frame) runs, and
 * typing that starts sooner (a fast typist, a busy frame) lands on the button: Space and Enter then
 * activate it again, toggling the formatting back and dropping the text (seen on macOS Chromium).
 * Keyboard activation is unaffected.
 */
function keepEditorFocus(e: MouseEvent) {
  if (e.button === 0) e.preventDefault()
}

function chainFrom(chain: ChainedCommands, e: MouseEvent): ChainedCommands {
  return e.detail > 0 ? chain.focus() : chain
}

const ALIGNMENTS: ReadonlyArray<{ key: ToolbarControlKey; value: Alignment; icon: () => ReactElement }> = [
  { key: 'alignLeft', value: 'left', icon: I.AlignLeftIcon },
  { key: 'alignCenter', value: 'center', icon: I.AlignCenterIcon },
  { key: 'alignRight', value: 'right', icon: I.AlignRightIcon },
  { key: 'alignJustify', value: 'justify', icon: I.AlignJustifyIcon },
]

/** The formatting state and the control builders shared by the toolbar's groups. */
function useFormatControls() {
  const editor = useActiveEditor()
  const s = useToolbarState(editor)
  const disabled = !editor || !s.ready

  const toggle = (key: ToolbarControlKey, pressed: boolean, run: (c: ChainedCommands) => ChainedCommands, icon: ReactElement) => {
    const meta = TOOLBAR_CONTROLS[key]
    return (
      <ToolbarItem disabled={disabled}>
        <Tooltip>
          <ToggleButton
            label={meta.label}
            data-control-id={meta.id}
            pressed={pressed}
            disabled={disabled}
            onPressedChange={() => {}}
            onMouseDown={keepEditorFocus}
            onClick={(e) => {
              e.preventDefault()
              if (editor) run(chainFrom(editor.chain(), e)).run()
            }}
          >
            {icon}
          </ToggleButton>
        </Tooltip>
      </ToolbarItem>
    )
  }

  const action = (key: ToolbarControlKey, enabled: boolean, run: (c: ChainedCommands) => ChainedCommands, icon: ReactElement) => {
    const meta = TOOLBAR_CONTROLS[key]
    return (
      <ToolbarItem disabled={disabled || !enabled}>
        <Tooltip>
          <IconButton
            label={meta.label}
            data-control-id={meta.id}
            disabled={disabled || !enabled}
            onMouseDown={keepEditorFocus}
            onClick={(e) => {
              if (editor) run(chainFrom(editor.chain(), e)).run()
            }}
          >
            {icon}
          </IconButton>
        </Tooltip>
      </ToolbarItem>
    )
  }

  const select = (key: ToolbarControlKey, value: string, presets: Parameters<typeof withCurrent>[0], apply: (v: string) => void, width: string) => {
    const meta = TOOLBAR_CONTROLS[key]
    return (
      <ToolbarItem disabled={disabled}>
        <Tooltip>
          <Select
            aria-label={meta.label}
            data-control-id={meta.id}
            wrapperClassName={width}
            options={withCurrent(presets, value)}
            value={value}
            disabled={disabled}
            onChange={(e) => apply(e.target.value)}
          />
        </Tooltip>
      </ToolbarItem>
    )
  }

  return { editor, s, disabled, toggle, action, select }
}

/** Font family and size. `compact`: narrower fields (the ribbon's compact Font group). */
export function FontControls({ compact = false, loadFonts = loadSystemFonts }: { compact?: boolean; loadFonts?: () => Promise<string[]> }) {
  const { editor, s, disabled, select } = useFormatControls()
  return (
    <>
      <ToolbarItem disabled={disabled}>
        <Tooltip controlId={TOOLBAR_CONTROLS.fontFamily.id}>
          <FontFamilyPicker loadFonts={loadFonts} disabled={disabled} wrapperClassName={compact ? 'w-32' : 'w-40'} />
        </Tooltip>
      </ToolbarItem>
      {select(
        'fontSize',
        s.fontSize,
        FONT_SIZES,
        (v) => {
          if (!editor) return
          if (v) markChain(editor).setFontSize(v).run()
          else markChain(editor).unsetFontSize().run()
        },
        compact ? 'w-28' : 'w-32',
      )}
    </>
  )
}

/** Bold, italic, underline. */
export function TextStyleControls() {
  const { s, toggle } = useFormatControls()
  return (
    <>
      {toggle('bold', s.bold, (c) => c.toggleBold(), <I.BoldIcon />)}
      {toggle('italic', s.italic, (c) => c.toggleItalic(), <I.ItalicIcon />)}
      {toggle('underline', s.underline, (c) => c.toggleUnderline(), <I.UnderlineIcon />)}
    </>
  )
}

/** Bulleted and numbered lists. */
export function ListControls() {
  const { s, toggle } = useFormatControls()
  return (
    <>
      {toggle('bulletList', s.bulletList, (c) => c.toggleBulletList(), <I.BulletListIcon />)}
      {toggle('orderedList', s.orderedList, (c) => c.toggleOrderedList(), <I.OrderedListIcon />)}
    </>
  )
}

/** Left, center, right, justify. */
export function AlignmentControls() {
  const { s, toggle } = useFormatControls()
  return (
    <>
      {ALIGNMENTS.map(({ key, value, icon: Icon }) => (
        <Fragment key={key}>
          {toggle(key, s.align === value, (c) => (value === 'left' ? c.unsetTextAlign() : c.setTextAlign(value)), <Icon />)}
        </Fragment>
      ))}
    </>
  )
}

/**
 * Line spacing, space after, first-line indent and the indent buttons. `compact` leaves out the three
 * fields (the ribbon then offers them as registry submenus in a "Spacing" dropdown).
 */
export function SpacingControls({ compact = false }: { compact?: boolean }) {
  const { editor, s, select, action } = useFormatControls()
  return (
    <>
      {compact ? null : (
        <>
          {select('lineSpacing', s.lineHeight, LINE_SPACINGS, (v) => editor?.chain().setBlockLineHeight(v || null).run(), 'w-32')}
          {select('paragraphSpacing', s.paragraphSpacing, PARAGRAPH_SPACINGS, (v) => editor?.chain().setBlockSpacing(v || null).run(), 'w-36')}
          {select('firstLineIndent', s.firstLineIndent, FIRST_LINE_INDENTS, (v) => editor?.chain().setFirstLineIndent(v || null).run(), 'w-40')}
        </>
      )}
      {action('indentDecrease', s.canOutdent, (c) => c.outdentBlock(), <I.IndentDecreaseIcon />)}
      {action('indentIncrease', s.canIndent, (c) => c.indentBlock(), <I.IndentIncreaseIcon />)}
    </>
  )
}

/** The Styles controls (picker, modify, manage, clear) and their dialogs. `bare`: no own group. */
export function StylesControls({ bare = false }: { bare?: boolean }) {
  const { editor, s, disabled } = useFormatControls()
  return (
    <StylesGroup
      editor={editor}
      disabled={disabled}
      styleId={s.styleId}
      fallbackStyleId={s.fallbackStyleId}
      bare={bare}
      item={(control) => <ToolbarItem disabled={disabled}>{control}</ToolbarItem>}
    />
  )
}

/**
 * Formatting toolbar (ARIA `toolbar` with roving focus): every formatting group in one bar. The app
 * shows these groups in its ribbon (@/features/ribbon); this bar composes them for tests and embeds.
 * Active states come from `useToolbarState`, which reads only the selection (see `readToolbarState`).
 */
export function Toolbar({ leadingGroups, extraGroups, loadFonts = loadSystemFonts, className }: ToolbarProps) {
  const editor = useActiveEditor()

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Only for the toolbar's own items: controls placed in the slots (e.g. a find field)
    // handle Escape themselves, and anything that already handled it is left alone.
    const target = e.target as HTMLElement
    if (e.defaultPrevented || !target.hasAttribute('data-radix-collection-item')) return
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
        <FontControls loadFonts={loadFonts} />
      </ToolbarGroup>
      <ToolbarSeparator />

      <ToolbarGroup label="Text style">
        <TextStyleControls />
      </ToolbarGroup>
      <ToolbarSeparator />

      <ToolbarGroup label="Lists">
        <ListControls />
      </ToolbarGroup>
      <ToolbarSeparator />

      <ToolbarGroup label="Alignment">
        <AlignmentControls />
      </ToolbarGroup>
      <ToolbarSeparator />

      <ToolbarGroup label="Spacing and indent" className="gap-1">
        <SpacingControls />
      </ToolbarGroup>
      <ToolbarSeparator />

      <StylesControls />

      {extraGroups ? (
        <>
          <ToolbarSeparator />
          {extraGroups}
        </>
      ) : null}
    </RToolbar.Root>
  )
}
