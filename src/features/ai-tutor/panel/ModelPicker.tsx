import * as Menu from '@radix-ui/react-dropdown-menu'
import { useStore } from '@/shared/store'
import { cn, focusRing, Tooltip } from '@/shared/ui'
import type { Connection } from '../connections/types'
import { setActiveTutorConnection } from '../connections/store'
import { modelSupportsTools } from '../providers/registry'
import { activeConnection, chooseModel, chosenModel, loadModels, requestComposerFocus, useTutorChat } from './chat'
import { NO_TOOLS_REASON, TUTOR_CONTROLS as C } from './controls'
import { menuContentClass, menuItemClass } from './ContextMenuPlus'
import { CheckIcon, ChevronDownIcon } from './icons'
import { connectProvider } from './connect'

/** The connection's models as the picker lists them (the chosen one first if the list lacks it). */
function useModelRows(c: Connection, active: boolean) {
  const entry = useTutorChat((s) => s.models[c.id])
  const picked = useTutorChat((s) => s.modelId)
  const chosen = (active ? picked : null) ?? c.defaultModel ?? null
  const models = entry?.models ?? []
  const rows = chosen && !models.some((m) => m.id === chosen) ? [{ id: chosen, label: chosen, tools: 'unknown' as const }, ...models] : models
  return { entry, rows, chosen }
}

function ConnectionModels({ c, active }: { c: Connection; active: boolean }) {
  const { entry, rows, chosen } = useModelRows(c, active)
  return (
    <Menu.Group aria-label={c.label}>
      <Menu.Label className="px-2.5 pb-0.5 pt-1.5 text-ui-xs font-semibold text-text-muted">{c.label}</Menu.Label>
      {entry?.status === 'loading' && rows.length === 0 ? <p className="px-2.5 py-1.5 text-ui-sm text-text-muted">Loading models…</p> : null}
      {entry?.status === 'error' && rows.length === 0 ? <p className="px-2.5 py-1.5 text-ui-sm text-text-muted">The models could not be listed.</p> : null}
      {rows.map((m) => {
        // The chosen model of the active connection; a model found not to use tools is listed but off.
        const known = entry?.status === 'ready' && entry.models.some((x) => x.id === m.id)
        const supported = !known || modelSupportsTools(c, m)
        const selected = active && m.id === chosen
        return (
          <Tooltip key={m.id} side="left" copy={{ title: m.label, description: supported ? C.modelItem.description : `${NO_TOOLS_REASON} ${C.modelItem.description}` }}>
            <Menu.Item
              data-control-id={C.modelItem.id}
              aria-disabled={supported ? undefined : true}
              data-unsupported={supported ? undefined : 'true'}
              className={cn(menuItemClass, 'pl-8', !supported && 'cursor-not-allowed opacity-60')}
              onSelect={(e) => {
                if (!supported) {
                  e.preventDefault()
                  return
                }
                chooseModel(c.id, m.id, setActiveTutorConnection)
              }}
            >
              {selected ? (
                <span className="absolute left-2 inline-flex">
                  <CheckIcon />
                </span>
              ) : null}
              <span className="min-w-0 flex-1 truncate">{m.label}</span>
              {!supported ? <span className="text-ui-xs text-text-muted">Can&apos;t use tools</span> : null}
            </Menu.Item>
          </Tooltip>
        )
      })}
    </Menu.Group>
  )
}

/**
 * The bottom bar: "Using: <connection> · <model> ▾". The models are listed when the menu opens (a
 * provider's model list, never manuscript text); a model without tool support is listed but cannot be
 * chosen. "Connect a Provider…" opens Settings.
 */
export function ModelPicker() {
  const connections = useStore((s) => s.tutorConnections.list) as Connection[]
  const activeId = useStore((s) => s.tutorConnections.activeId)
  const modelId = useTutorChat((s) => s.modelId)
  const models = useTutorChat((s) => s.models)
  const busy = useTutorChat((s) => s.busy)
  void modelId
  const active = activeConnection()
  const chosen = chosenModel(active)
  const label = active ? (models[active.id]?.models.find((m) => m.id === chosen)?.label ?? chosen ?? 'Choose a model') : 'Not connected'
  const text = active ? `${active.label} · ${label}` : label
  return (
    <Menu.Root
      modal={false}
      onOpenChange={(open) => {
        if (open) for (const c of connections) void loadModels(c)
      }}
    >
      <Tooltip copy={{ title: C.model.label, description: `${C.model.description} Now: ${text}.` }} side="top">
        <Menu.Trigger asChild disabled={busy}>
          <button
            type="button"
            data-control-id={C.model.id}
            aria-label={`Model: ${text}`}
            className={cn(
              'mt-1 inline-flex min-h-control max-w-full items-center gap-1 rounded-control px-1.5 text-ui-xs text-text-muted hover:bg-surface-hover hover:text-text disabled:cursor-not-allowed disabled:opacity-60',
              focusRing,
            )}
          >
            <span className="truncate">
              Using: <span className="font-medium text-text">{text}</span>
            </span>
            <ChevronDownIcon />
          </button>
        </Menu.Trigger>
      </Tooltip>
      <Menu.Portal>
        <Menu.Content
          side="top"
          align="start"
          sideOffset={4}
          collisionPadding={8}
          className={cn(menuContentClass, 'max-h-[min(28rem,70vh)] overflow-y-auto')}
          onCloseAutoFocus={(e) => {
            e.preventDefault()
            requestComposerFocus()
          }}
        >
          {connections.map((c) => (
            <ConnectionModels key={c.id} c={c} active={c.id === activeId} />
          ))}
          {connections.length ? <Menu.Separator className="my-1 h-px bg-border" /> : null}
          <Tooltip controlId={C.connect.id} side="left">
            <Menu.Item data-control-id={C.connect.id} className={menuItemClass} onSelect={() => connectProvider()}>
              <span className="flex-1">Connect a Provider…</span>
            </Menu.Item>
          </Tooltip>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  )
}
