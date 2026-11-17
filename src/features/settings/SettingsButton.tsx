import type { IconButtonProps } from '@/shared/ui'
import { IconButton, Tooltip } from '@/shared/ui'
import { SETTINGS_CONTROLS } from './controls'
import { openSettings, useDialogState } from './dialog-state'

export type SettingsButtonProps = Partial<Omit<IconButtonProps, 'label' | 'children'>>

/** A gear. */
function GearIcon() {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="2.25" />
      <path d="M8 1.5v1.75M8 12.75v1.75M1.5 8h1.75M12.75 8h1.75M3.4 3.4l1.25 1.25M11.35 11.35l1.25 1.25M12.6 3.4l-1.25 1.25M4.65 11.35L3.4 12.6" />
    </svg>
  )
}

/**
 * Toolbar button (`settings.open`) that opens the Settings dialog; the same as Mod-,. Extra props
 * and `ref` are forwarded, so it can be wrapped in the editor's `ToolbarItem`.
 */
export function SettingsButton({ onClick, ...rest }: SettingsButtonProps) {
  const open = useDialogState().settingsOpen
  return (
    <Tooltip {...rest}>
      <IconButton
        label={SETTINGS_CONTROLS.open.label}
        data-control-id={SETTINGS_CONTROLS.open.id}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(e) => {
          onClick?.(e)
          if (!e.defaultPrevented) openSettings()
        }}
      >
        <GearIcon />
      </IconButton>
    </Tooltip>
  )
}
