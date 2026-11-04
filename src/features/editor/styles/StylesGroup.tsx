import type { Editor } from '@tiptap/core'
import { useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { DEFAULT_STYLE_ID } from '@/shared/book'
import { IconButton, Select, ToolbarGroup, Tooltip } from '@/shared/ui'
import type { SelectOption } from '@/shared/ui'
import { blockPlainText } from '../block-text'
import { TOOLBAR_CONTROLS } from '../toolbar/controls'
import { ManageStylesDialog } from './ManageStylesDialog'
import { ModifyStyleDialog } from './ModifyStyleDialog'
import { useResolvedStyles } from './resolved'

export interface StylesGroupProps {
  editor: Editor | null
  disabled: boolean
  /** Effective style of the block at the selection ('' outside styled blocks). */
  styleId: string
  /** What the block renders like when `styleId` names no defined style. */
  fallbackStyleId: string
  /** Wraps one focusable control as a toolbar item (roving focus). */
  item: (control: ReactElement) => ReactNode
}

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  )
}
/** Pilcrow with a pen nib: edit the paragraph style. */
const ModifyIcon = () => (
  <Icon>
    <path d="M7.5 9.5V2.5M10 9.5V2.5M11.5 2.5H6.25a2.5 2.5 0 0 0 0 5H7.5" />
    <path d="M9.5 13.5l4-4 1 1-4 4H9.5z" />
  </Icon>
)
/** A stack of differently set lines: the book's styles. */
const ManageIcon = () => (
  <Icon>
    <path d="M3 3h10" strokeWidth="2.25" />
    <path d="M3 7.5h7M3 10.5h10M3 13.5h10" />
  </Icon>
)
/** A struck "T": remove direct formatting. */
const ClearIcon = () => (
  <Icon>
    <path d="M3.5 3.5h8M7.5 3.5v9" />
    <path d="M10.5 10l3.5 3.5M14 10l-3.5 3.5" />
  </Icon>
)

/**
 * Toolbar "Styles" group: style picker (current block's style, applies on change), Modify style,
 * Manage styles and Clear direct formatting, plus the two dialogs.
 */
export function StylesGroup({ editor, disabled, styleId, fallbackStyleId, item }: StylesGroupProps) {
  const styles = useResolvedStyles()
  const [modifying, setModifying] = useState<string | null>(null)
  const [managing, setManaging] = useState(false)
  const [sample, setSample] = useState<string | undefined>()

  const options: SelectOption[] = [...styles.values()].map((s) => ({ value: s.id, label: s.name }))
  if (styleId && !styles.has(styleId)) {
    // A deleted or unknown style renders like its fallback (see buildStyleSheetCSS); say so.
    const fallback = styles.get(fallbackStyleId)?.name ?? 'Body'
    options.unshift({ value: styleId, label: `${fallback} (missing style)` })
  }
  if (!styleId) options.unshift({ value: '', label: 'No style' })

  const currentText = () => {
    const block = editor?.state.selection.$from.parent
    return block ? blockPlainText(block).slice(0, 280) : undefined
  }
  const picker = TOOLBAR_CONTROLS.stylePicker
  const edit = TOOLBAR_CONTROLS.styleEdit
  const manage = TOOLBAR_CONTROLS.styleManage
  const clear = TOOLBAR_CONTROLS.clearFormatting

  return (
    <ToolbarGroup label="Styles" className="gap-1">
      {item(
        <Tooltip>
          <Select
            aria-label={picker.label}
            data-control-id={picker.id}
            wrapperClassName="w-44"
            options={options}
            value={styleId}
            disabled={disabled}
            onChange={(e) => {
              if (e.target.value) editor?.chain().setBlockStyle(e.target.value).run()
            }}
          />
        </Tooltip>,
      )}
      {item(
        <Tooltip>
          <IconButton
            label={edit.label}
            data-control-id={edit.id}
            disabled={disabled}
            onClick={() => {
              setSample(currentText())
              setModifying(styles.has(styleId) ? styleId : fallbackStyleId || DEFAULT_STYLE_ID)
            }}
          >
            <ModifyIcon />
          </IconButton>
        </Tooltip>,
      )}
      {item(
        <Tooltip>
          <IconButton label={manage.label} data-control-id={manage.id} disabled={disabled} onClick={() => setManaging(true)}>
            <ManageIcon />
          </IconButton>
        </Tooltip>,
      )}
      {item(
        <Tooltip>
          <IconButton
            label={clear.label}
            data-control-id={clear.id}
            disabled={disabled}
            onClick={(e) => {
              if (!editor) return
              const chain = editor.chain()
              ;(e.detail > 0 ? chain.focus() : chain).clearDirectFormatting().run()
            }}
          >
            <ClearIcon />
          </IconButton>
        </Tooltip>,
      )}
      <ManageStylesDialog
        open={managing}
        onOpenChange={setManaging}
        initialStyleId={styleId || DEFAULT_STYLE_ID}
        onModify={(id) => {
          setSample(undefined)
          setModifying(id)
        }}
      />
      <ModifyStyleDialog styleId={modifying} onClose={() => setModifying(null)} sample={sample} />
    </ToolbarGroup>
  )
}
