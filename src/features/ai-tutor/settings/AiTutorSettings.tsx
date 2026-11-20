import { useEffect, useId, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { useStore } from '@/shared/store'
import { Button, Checkbox, Dialog, Select, TextInput, Tooltip, cn } from '@/shared/ui'
import type { SelectOption } from '@/shared/ui'
import { hasSecret, deleteSecret, setSecret } from '../connections/ipc'
import { loadTutorConnections, saveTutorConnections, setActiveTutorConnection } from '../connections/store'
import { USER_HOSTED_PROVIDERS, type Connection, type ProviderId } from '../connections/types'
import { useTutorHistory } from '../history/store'
import { forgetModels, useTutorChat } from '../panel/chat'
import { NO_TOOLS_REASON } from '../panel/controls'
import { getAdapter, listAdapters } from '../providers/registry'
import type { ModelInfo } from '../providers/types'
import { AI_SETTINGS_CONTROLS as C, HISTORY_NOTE, SUBSCRIPTION_NOTE } from './controls'
import type { AiSettingsControlKey } from './controls'
import { openKeyPage } from './ipc'
import { beginSignIn, cancelSignIn, useSignIn } from './sign-in'
import { baseUrlHint, baseUrlProblem, needsInsecureConfirm, normaliseBaseUrl, originOf } from './url'

/**
 * Settings ▸ AI Tutor (Phase 5 Task 10; design "Network and credentials"). The saved connections (add,
 * edit, remove, set as default), Sign in with OpenRouter, and the chat history. A key typed here goes
 * straight to the keychain (`setSecret`, after the connection is saved: the secret is bound to it) and is
 * never shown again: the field always opens empty, with "Key saved" when the keychain holds one.
 */

// ---- Small pieces ---------------------------------------------------------------------------------

type Tone = 'muted' | 'success' | 'danger'
interface Status {
  tone: Tone
  text: string
}

const toneClass: Record<Tone, string> = { muted: 'text-text-muted', success: 'text-success', danger: 'text-danger' }

function StatusLine({ status, testId }: { status: Status | null; testId?: string }) {
  return (
    // Always in the page (a live region must exist before it speaks); empty, it takes no height.
    <p role="status" data-testid={testId} className={cn('m-0 text-ui-xs', status ? toneClass[status.tone] : '')}>
      {status?.text ?? ''}
    </p>
  )
}

const messageOf = (e: unknown, fallback: string): string =>
  e instanceof Error && e.message ? e.message : typeof e === 'object' && e && typeof (e as { message?: unknown }).message === 'string' ? (e as { message: string }).message : fallback

/** A button with its tooltip (the registry copy of `key`). */
function Action({ k, label, ...rest }: { k: AiSettingsControlKey; label?: string } & Omit<Parameters<typeof Button>[0], 'children'>) {
  return (
    <Tooltip>
      {/* A row's button names its connection ("Edit Work") for screen readers. */}
      <Button data-control-id={C[k].id} aria-label={label ? `${C[k].label} ${label}` : undefined} {...rest}>
        {C[k].label}
      </Button>
    </Tooltip>
  )
}

interface Confirm {
  title: string
  message: string
  yes: AiSettingsControlKey
  danger?: boolean
  onYes: () => void
}

function ConfirmDialog({ confirm, onClose }: { confirm: Confirm | null; onClose: () => void }) {
  return (
    <Dialog
      open={confirm !== null}
      onOpenChange={(o) => !o && onClose()}
      title={confirm?.title ?? ''}
      description={confirm?.message}
      footer={
        confirm ? (
          <>
            <Action k="confirmNo" onClick={onClose} />
            <Action
              k={confirm.yes}
              variant={confirm.danger ? 'danger' : 'primary'}
              onClick={() => {
                onClose()
                confirm.onYes()
              }}
            />
          </>
        ) : null
      }
    />
  )
}

// ---- Drafts ---------------------------------------------------------------------------------------

/** What the connection form edits. The key is only what was typed now (never a saved one). */
interface Draft {
  /** null: a new connection, not saved yet. */
  id: string | null
  provider: ProviderId
  label: string
  key: string
  baseUrl: string
  defaultModel: string
  toolSupport: Record<string, boolean>
  /** The origin the writer agreed to send plain http to (null: not agreed). */
  acceptedOrigin: string | null
}

/** Chosen in the form (ChatGPT sign-in is Task 12; its adapter does not exist yet). */
const PROVIDER_OPTIONS: SelectOption[] = listAdapters().map((a) => ({ value: a.id, label: a.label }))
const userHosted = (p: ProviderId) => USER_HOSTED_PROVIDERS.includes(p)
/** A key when the provider takes one (optional when it also works without); a sign-in stays a sign-in. */
const authOf = (p: ProviderId, existing?: Connection): Connection['auth'] =>
  existing?.auth === 'oauth' ? 'oauth' : getAdapter(p).connectKinds.includes('api_key') ? 'api_key' : 'none'
const keyOptional = (p: ProviderId) => getAdapter(p).connectKinds.includes('none')
const newId = (p: ProviderId) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`

function newDraft(provider: ProviderId = 'anthropic'): Draft {
  return {
    id: null,
    provider,
    label: getAdapter(provider).label,
    key: '',
    baseUrl: getAdapter(provider).defaultBaseUrl ?? '',
    defaultModel: '',
    toolSupport: {},
    acceptedOrigin: null,
  }
}

function draftOf(c: Connection): Draft {
  return {
    id: c.id,
    provider: c.provider,
    label: c.label,
    key: '',
    baseUrl: c.baseUrl ?? '',
    defaultModel: c.defaultModel ?? '',
    toolSupport: { ...c.toolSupport },
    acceptedOrigin: c.insecureHttpAccepted ? originOf(c.baseUrl) : null,
  }
}

const providerLabel = (p: ProviderId) => {
  try {
    return getAdapter(p).label
  } catch {
    return p
  }
}

// ---- The page -------------------------------------------------------------------------------------

export function AiTutorSettings() {
  const connections = useStore((s) => s.tutorConnections.list) as Connection[]
  const activeId = useStore((s) => s.tutorConnections.activeId)
  const loaded = useStore((s) => s.tutorConnections.loaded)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [keys, setKeys] = useState<Record<string, boolean>>({})
  const [listStatus, setListStatus] = useState<Status | null>(null)
  const pageId = useId()

  useEffect(() => {
    if (!loaded) loadTutorConnections().catch(() => setListStatus({ tone: 'danger', text: 'The saved connections could not be read.' }))
  }, [loaded])

  // "Key saved": ask the keychain (yes or no only; a key is never read back).
  useEffect(() => {
    let live = true
    for (const c of connections) {
      if (c.auth === 'none') continue
      hasSecret(c.id)
        .then((has) => live && setKeys((k) => (k[c.id] === has ? k : { ...k, [c.id]: has })))
        .catch(() => {})
    }
    return () => {
      live = false
    }
  }, [connections])

  const refreshKey = (id: string) => hasSecret(id).then((has) => setKeys((k) => ({ ...k, [id]: has })), () => {})

  const remove = (c: Connection) =>
    setConfirm({
      title: `Remove “${c.label}”?`,
      message: 'The tutor can no longer use it, and its saved key is deleted from this computer’s keychain.',
      yes: 'removeConfirm',
      danger: true,
      onYes: async () => {
        try {
          await saveTutorConnections(connections.filter((x) => x.id !== c.id))
          await deleteSecret(c.id).catch(() => {})
          forgetModels(c.id)
          if (draft?.id === c.id) setDraft(null)
          setListStatus({ tone: 'muted', text: `Removed “${c.label}”.` })
        } catch (e) {
          setListStatus({ tone: 'danger', text: messageOf(e, 'The connection could not be removed.') })
        }
      },
    })

  return (
    <div className="flex flex-col">
      <Section id={`${pageId}-connections`} title="Connections">
        <p className="m-0 text-ui-xs text-text-muted" data-testid="ai-subscription-note">
          {SUBSCRIPTION_NOTE}
        </p>
        <div className="flex flex-col gap-1">
          {connections.length ? (
            <ul aria-label="Connections" className="m-0 flex list-none flex-col gap-2 p-0">
              {connections.map((c) => {
                const isDefault = c.id === activeId
                return (
                  <li key={c.id} data-connection-id={c.id} className="flex flex-wrap items-center gap-2 rounded-control border border-border px-3 py-2">
                    <div className="min-w-0 flex-1 basis-48">
                      <p className="m-0 truncate text-ui font-medium">
                        {c.label}
                        {isDefault ? <span className="ml-2 text-ui-xs font-normal text-text-muted">(Default)</span> : null}
                      </p>
                      <p className="m-0 text-ui-xs text-text-muted">
                        {providerLabel(c.provider)}
                        {c.auth === 'oauth' ? ' · Signed in' : c.auth === 'api_key' ? (keys[c.id] ? ' · Key saved' : keyOptional(c.provider) ? '' : ' · No key saved') : ''}
                        {c.defaultModel ? ` · ${c.defaultModel}` : ''}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {isDefault ? null : <Action k="setDefault" label={c.label} onClick={() => setActiveTutorConnection(c.id)} />}
                      <Action k="edit" label={c.label} onClick={() => setDraft(draftOf(c))} />
                      <Action k="remove" label={c.label} onClick={() => remove(c)} />
                    </div>
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="m-0 text-ui-sm text-text-muted">
              No connections yet. Sign in with OpenRouter, or add a provider with an API key or a model on this computer.
            </p>
          )}
          <StatusLine status={listStatus} testId="ai-settings-list-status" />
        </div>
        <SignInRow add={draft ? null : <Action k="add" onClick={() => setDraft(newDraft())} />} />
        {draft ? (
          <ConnectionForm
            key={draft.id ?? 'new'}
            initial={draft}
            connections={connections}
            hasKey={draft.id ? !!keys[draft.id] : false}
            onKeyChanged={refreshKey}
            onConfirm={setConfirm}
            onClose={(saved) => {
              setDraft(null)
              if (saved) setListStatus({ tone: 'success', text: `Saved “${saved}”.` })
            }}
          />
        ) : null}
      </Section>
      <HistorySection id={`${pageId}-history`} onConfirm={setConfirm} />
      <ConfirmDialog confirm={confirm} onClose={() => setConfirm(null)} />
    </div>
  )
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3 border-t border-border py-3 first:border-t-0 first:pt-0">
      <h3 id={id} className="m-0 text-ui font-semibold">
        {title}
      </h3>
      {children}
    </section>
  )
}

/** Add Connection… (while no form is open) and Sign in with OpenRouter, with the sign-in's progress. */
function SignInRow({ add }: { add: ReactNode }) {
  const { status, message } = useSignIn()
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        {add}
        <Action k="signIn" variant="primary" disabled={status === 'waiting'} onClick={() => void beginSignIn()} />
        {status === 'waiting' ? <Action k="signInCancel" onClick={() => void cancelSignIn()} /> : null}
      </div>
      <StatusLine
        testId="ai-sign-in-status"
        status={message ? { tone: status === 'failed' ? 'danger' : status === 'done' ? 'success' : 'muted', text: message } : null}
      />
    </div>
  )
}

// ---- The connection form --------------------------------------------------------------------------

interface FormProps {
  initial: Draft
  connections: Connection[]
  hasKey: boolean
  onKeyChanged: (id: string) => void
  onConfirm: (c: Confirm) => void
  /** Closed; `saved` is the saved connection's name (undefined: cancelled). */
  onClose: (saved?: string) => void
}

function ConnectionForm({ initial, connections, hasKey, onKeyChanged, onConfirm, onClose }: FormProps) {
  const [d, setD] = useState<Draft>(initial)
  const [status, setStatus] = useState<Status | null>(null)
  const [busy, setBusy] = useState(false)
  const formId = useId()
  const existing = connections.find((c) => c.id === d.id)
  const adapter = getAdapter(d.provider)
  const auth = authOf(d.provider, existing)
  const hosted = userHosted(d.provider)
  const cached = useTutorChat((s) => (d.id ? s.models[d.id] : undefined))
  const [tested, setTested] = useState<ModelInfo[] | null>(null)
  const models = tested ?? (cached?.status === 'ready' ? cached.models : [])
  const patch = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }))

  const chosen = models.find((m) => m.id === d.defaultModel)
  const modelOptions: SelectOption[] = [
    { value: '', label: 'Choose in the tutor' },
    ...(d.defaultModel && !chosen ? [{ value: d.defaultModel, label: d.defaultModel }] : []),
    ...models.map((m) => ({ value: m.id, label: m.tools === 'no' ? `${m.label} (can't use tools)` : m.label })),
  ]
  // R9: a model known not to call tools says so; one of unknown support can be switched on by the writer.
  const toolsKnown = chosen?.tools === 'yes' || chosen?.tools === 'no'
  const urlProblem = hosted && d.baseUrl.trim() ? baseUrlProblem(d.baseUrl) : null
  const urlHint = hosted ? baseUrlHint(adapter.apiPath, d.baseUrl) : null

  /** The connection as it would be saved, keeping fields this form does not know. */
  function build(id: string, baseUrl: string | undefined, toolSupport: Record<string, boolean>): Connection {
    const c: Connection = { ...(existing ?? {}), id, provider: d.provider, label: d.label.trim() || adapter.label, auth }
    delete c.baseUrl
    delete c.insecureHttpAccepted
    delete c.defaultModel
    delete c.toolSupport
    if (baseUrl) c.baseUrl = baseUrl
    if (baseUrl && needsInsecureConfirm(baseUrl)) c.insecureHttpAccepted = true
    if (d.defaultModel) c.defaultModel = d.defaultModel
    if (Object.keys(toolSupport).length) c.toolSupport = toolSupport
    return c
  }

  async function store(c: Connection): Promise<void> {
    const list = connections.some((x) => x.id === c.id) ? connections.map((x) => (x.id === c.id ? c : x)) : [...connections, c]
    // The connection is saved first: Rust binds the key to the saved connection (provider, auth, origin).
    await saveTutorConnections(list)
    forgetModels(c.id)
  }

  async function commit(mode: 'save' | 'test', accepted: string | null = d.acceptedOrigin): Promise<void> {
    if (hosted) {
      const problem = baseUrlProblem(d.baseUrl)
      if (problem) {
        setStatus({ tone: 'danger', text: problem })
        return
      }
    }
    const baseUrl = hosted ? normaliseBaseUrl(adapter.apiPath, d.baseUrl) : undefined
    // Global Constraints: plain http to another computer needs the writer's yes, for this host.
    if (baseUrl && needsInsecureConfirm(baseUrl) && accepted !== originOf(baseUrl)) {
      onConfirm({
        title: 'Send your text unencrypted?',
        message: `This address uses plain http, so your questions and any manuscript text you attach travel unencrypted to ${new URL(baseUrl).host}. Anyone on the network between you could read them. Use https if the server offers it.`,
        yes: 'insecureAccept',
        onYes: () => {
          patch({ acceptedOrigin: originOf(baseUrl) })
          void commit(mode, originOf(baseUrl))
        },
      })
      return
    }
    setBusy(true)
    setStatus({ tone: 'muted', text: mode === 'test' ? 'Testing…' : 'Saving…' })
    const id = d.id ?? newId(d.provider)
    let c = build(id, baseUrl, d.toolSupport)
    try {
      await store(c)
      if (d.key.trim()) {
        await setSecret(id, d.key.trim())
        onKeyChanged(id)
      }
      // The key field empties once saved: a key is never shown again.
      setD((x) => ({ ...x, id, key: '', baseUrl: baseUrl ?? x.baseUrl, acceptedOrigin: accepted }))
    } catch (e) {
      setBusy(false)
      setStatus({ tone: 'danger', text: messageOf(e, 'The connection could not be saved.') })
      return
    }
    if (mode === 'save') {
      setBusy(false)
      onClose(c.label)
      return
    }
    try {
      const found = await adapter.listModels(c, { strict: true })
      setTested(found)
      forgetModels(id, found)
      let text = found.length ? `Connected. ${found.length === 1 ? '1 model' : `${found.length} models`} found.` : 'Connected, but the provider listed no models.'
      if (adapter.probeTools && found.length) {
        const model = d.defaultModel || found[0].id
        const ok = await adapter.probeTools(c, model)
        const toolSupport = { ...d.toolSupport, [model]: ok }
        c = { ...build(id, baseUrl, toolSupport), defaultModel: model }
        await store(c)
        forgetModels(id, found)
        setD((x) => ({ ...x, defaultModel: model, toolSupport }))
        text += ok ? ` ${model} can use tools.` : ` ${model} did not call a tool in the test. If you know it can, tick “${C.toolsOverride.label}”.`
      }
      setStatus({ tone: 'success', text })
    } catch (e) {
      setStatus({ tone: 'danger', text: `The test failed: ${messageOf(e, 'the provider could not be reached.')}` })
    } finally {
      setBusy(false)
    }
  }

  const field = (key: AiSettingsControlKey, control: (p: { id: string; 'data-control-id': string; 'aria-describedby'?: string }) => ReactElement, hint?: ReactNode, extra?: ReactNode) => {
    const id = `${formId}-${key}`
    return (
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <label htmlFor={id} className="text-ui-xs font-medium text-text-muted">
            {C[key].label}
          </label>
          {extra}
        </div>
        <Tooltip>{control({ id, 'data-control-id': C[key].id, ...(hint ? { 'aria-describedby': `${id}-hint` } : {}) })}</Tooltip>
        {hint ? (
          <p id={`${id}-hint`} className="m-0 text-ui-xs text-text-muted">
            {hint}
          </p>
        ) : null}
      </div>
    )
  }

  return (
    <form
      aria-label={d.id ? `Edit ${initial.label}` : 'Add connection'}
      className="flex flex-col gap-3 rounded-control border border-border p-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (!busy) void commit('save')
      }}
    >
      <h4 className="m-0 text-ui font-semibold">{d.id && existing ? `Edit “${existing.label}”` : 'Add a connection'}</h4>
      {field(
        'provider',
        (p) => (
          <Select
            {...p}
            value={d.provider}
            options={PROVIDER_OPTIONS}
            disabled={!!existing || busy}
            onChange={(e) => {
              const provider = e.target.value as ProviderId
              const fresh = newDraft(provider)
              // A name the writer typed is kept; the provider's own name follows the provider.
              patch({ provider, baseUrl: fresh.baseUrl, label: d.label === adapter.label || !d.label.trim() ? fresh.label : d.label, defaultModel: '', toolSupport: {} })
              setTested(null)
            }}
          />
        ),
        existing ? 'To use another provider, add a new connection.' : undefined,
      )}
      {field('label', (p) => <TextInput {...p} value={d.label} maxLength={200} onChange={(e) => patch({ label: e.target.value })} />)}
      {auth === 'oauth' ? (
        <p className="m-0 text-ui-xs text-text-muted">
          Signed in with OpenRouter{hasKey ? '. Key saved' : ''}. To use another account, remove this connection and sign in again.
        </p>
      ) : auth === 'api_key' ? (
        field(
          'key',
          (p) => (
            <TextInput
              {...p}
              type="password"
              autoComplete="off"
              spellCheck={false}
              // Never pre-filled: the webview cannot read a saved key, and does not keep a typed one.
              value={d.key}
              placeholder={hasKey ? 'Type a new key to replace the saved one' : keyOptional(d.provider) ? 'Optional' : ''}
              onChange={(e) => patch({ key: e.target.value })}
            />
          ),
          keyOptional(d.provider) ? 'Only if the server asks for one.' : 'Kept in this computer’s keychain, never in a file.',
          <>
            {hasKey ? (
              <span className="text-ui-xs font-medium text-success" data-testid="ai-key-saved">
                Key saved
              </span>
            ) : null}
            {adapter.keyHelpUrl ? (
              <Action
                k="getKey"
                type="button"
                onClick={() => openKeyPage(d.provider).catch((e: unknown) => setStatus({ tone: 'danger', text: messageOf(e, 'The page could not be opened.') }))}
              />
            ) : null}
          </>,
        )
      ) : null}
      {hosted
        ? field(
            'baseUrl',
            (p) => (
              <TextInput
                {...p}
                type="url"
                inputMode="url"
                spellCheck={false}
                value={d.baseUrl}
                placeholder="http://localhost:11434/v1"
                aria-invalid={urlProblem ? true : undefined}
                onChange={(e) => patch({ baseUrl: e.target.value })}
                onBlur={() => !baseUrlProblem(d.baseUrl) && patch({ baseUrl: normaliseBaseUrl(adapter.apiPath, d.baseUrl) })}
              />
            ),
            urlProblem ?? urlHint ?? (needsInsecureConfirm(d.baseUrl) ? 'Plain http to another computer: Novel asks before saving.' : 'On this computer, or https to another one.'),
          )
        : null}
      {field(
        'defaultModel',
        (p) => <Select {...p} value={d.defaultModel} options={modelOptions} disabled={busy} onChange={(e) => patch({ defaultModel: e.target.value })} />,
        models.length ? undefined : 'Test Connection lists the models.',
      )}
      {d.defaultModel && chosen?.tools === 'no' ? (
        <p className="m-0 text-ui-xs text-text-muted" data-testid="ai-model-no-tools">
          Not supported: {NO_TOOLS_REASON}
        </p>
      ) : null}
      {d.defaultModel && !toolsKnown ? (
        <Tooltip>
          <Checkbox
            data-control-id={C.toolsOverride.id}
            label={C.toolsOverride.label}
            checked={d.toolSupport[d.defaultModel] === true}
            onCheckedChange={(on) => patch({ toolSupport: { ...d.toolSupport, [d.defaultModel]: on } })}
          />
        </Tooltip>
      ) : null}
      <StatusLine status={status} testId="ai-settings-form-status" />
      <div className="flex flex-wrap justify-end gap-2">
        <Action k="cancel" type="button" disabled={busy} onClick={() => onClose()} />
        <Action k="test" type="button" disabled={busy} onClick={() => void commit('test')} />
        <Action k="save" type="submit" variant="primary" disabled={busy} />
      </div>
    </form>
  )
}

// ---- Chat history ---------------------------------------------------------------------------------

function HistorySection({ id, onConfirm }: { id: string; onConfirm: (c: Confirm) => void }) {
  const projectPath = useStore((s) => s.project.path)
  const projectTitle = useStore((s) => s.project.title)
  const [status, setStatus] = useState<Status | null>(null)
  const run = async (what: 'project' | 'all') => {
    const h = useTutorHistory.getState()
    await (what === 'project' ? h.clearProject() : h.clearAll())
    const error = useTutorHistory.getState().error
    setStatus(error ? { tone: 'danger', text: error } : { tone: 'success', text: what === 'project' ? "This project's chats were deleted." : 'All chats were deleted.' })
  }
  return (
    <Section id={id} title="Chat history">
      <p className="m-0 text-ui-xs text-text-muted" data-testid="ai-history-note">
        {HISTORY_NOTE}
      </p>
      <div className="flex flex-wrap gap-2">
        <Action
          k="clearProject"
          disabled={!projectPath}
          onClick={() =>
            onConfirm({
              title: `Clear the chats of “${projectTitle ?? 'this project'}”?`,
              message: 'Every tutor chat of this project is deleted from this computer. This cannot be undone.',
              yes: 'clearProjectConfirm',
              danger: true,
              onYes: () => void run('project'),
            })
          }
        />
        <Action
          k="clearAll"
          onClick={() =>
            onConfirm({
              title: 'Clear all chats?',
              message: 'Every tutor chat of every project is deleted from this computer. This cannot be undone.',
              yes: 'clearAllConfirm',
              danger: true,
              onYes: () => void run('all'),
            })
          }
        />
      </div>
      <StatusLine status={status} testId="ai-history-status" />
    </Section>
  )
}
