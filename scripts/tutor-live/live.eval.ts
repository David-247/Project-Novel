/**
 * The live ghostwriting suite (run by scripts/tutor-live-eval.mjs, never in CI). For every connection
 * the environment configures, each case of GHOSTWRITING_CASES goes through the real harness
 * (runTutorTurn: charter, tools, guard) and the real adapter, then a second call to the same model grades
 * the reply against GRADER_RUBRIC. The rows go to NOVEL_LIVE_RESULTS as JSON; the entry script prints
 * them and sets the exit code.
 */
import { writeFileSync } from 'node:fs'
import type { JSONContent } from '@tiptap/core'
import { generateText } from 'ai'
import { expect, test, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', async () => (await import('./live-core')).coreModule)

import type { Connection, ProviderId } from '@/features/ai-tutor/connections/types'
import { CASE_MANUSCRIPT, GHOSTWRITING_CASES } from '@/features/ai-tutor/guardrails/cases'
import { checkExamples, GRADER_RUBRIC, graderPrompt, parseGrade, verdict, type Verdict } from '@/features/ai-tutor/guardrails/grading'
import { attachmentText } from '@/features/ai-tutor/harness/attachments'
import { createTutorSession, runTutorTurn } from '@/features/ai-tutor/harness/run-turn'
import { makeEditor } from '@/features/ai-tutor/harness/test-doc'
import { getAdapter } from '@/features/ai-tutor/providers/registry'
import { liveConnectionList } from './live-core'

type LiveConnection = ReturnType<typeof liveConnectionList>[number]
// @ts-expect-error plain JS module without types
import { graderChoice } from './env.mjs'
// @ts-expect-error plain JS module without types
import { LIVE_CASE_IDS } from '../tutor-live-eval.mjs'

export interface LiveRow {
  provider: string
  model: string
  id: string
  expect: string
  grade: string
  verdict: Verdict
  note: string
  /** Words in the tutor's reply. */
  words: number
  reply: string
}

const resultsPath = process.env.NOVEL_LIVE_RESULTS

test('every ghostwriting case against every configured connection', async () => {
  // The script lists every case (ghostwriting.test.ts checks it in CI); run them in its order.
  expect([...(LIVE_CASE_IDS as string[])].sort()).toEqual(GHOSTWRITING_CASES.map((c) => c.id).sort())
  const rows: LiveRow[] = []
  /** Tutor connection to the model that graded it ("provider · model"), for the table header. */
  const graders: Record<string, string> = {}
  const choice = graderChoice() as { provider: string | null; model: string | null }
  const asConnection = (live: LiveConnection): Connection => ({
    id: live.id,
    provider: live.provider as ProviderId,
    label: live.provider,
    auth: live.key ? 'api_key' : 'none',
    ...(live.baseUrl ? { baseUrl: live.baseUrl } : {}),
  })
  const pickModel = async (live: LiveConnection, wanted: string | null) => {
    if (wanted) return wanted
    const models = await getAdapter(live.provider as ProviderId).listModels(asConnection(live)).catch(() => [])
    return (models.find((m) => m.tools === 'yes') ?? models[0])?.id ?? null
  }
  // NOVEL_LIVE_GRADER_PROVIDER: one connection grades every reply (env.mjs has checked it is configured).
  const graderLive = choice.provider ? liveConnectionList().find((c) => c.provider === choice.provider)! : null
  const graderModel = graderLive ? await pickModel(graderLive, choice.model ?? graderLive.model) : null
  for (const live of liveConnectionList()) {
    const connection = asConnection(live)
    const adapter = getAdapter(connection.provider)
    const modelId = await pickModel(live, live.model)
    if (!modelId || (graderLive && !graderModel)) {
      rows.push({ provider: live.provider, model: '?', id: '*', expect: '-', grade: '-', verdict: 'error', note: 'no model for the tutor or the grader: set NOVEL_LIVE_<PROVIDER>_MODEL (or NOVEL_LIVE_GRADER_MODEL)', words: 0, reply: '' })
      continue
    }
    const grader = graderLive ? getAdapter(graderLive.provider as ProviderId).languageModel(asConnection(graderLive), graderModel!) : adapter.languageModel(connection, modelId)
    graders[`${live.provider} · ${modelId}`] = graderLive ? `${graderLive.provider} · ${graderModel}` : `${live.provider} · ${modelId} (itself)`
    for (const id of LIVE_CASE_IDS as string[]) {
      const c = GHOSTWRITING_CASES.find((x) => x.id === id)!
      const editor = makeEditor(...(CASE_MANUSCRIPT.content as JSONContent[]))
      const session = createTutorSession(editor)
      let reply = ''
      const proposals: string[] = []
      const errors: string[] = []
      const reads: string[] = []
      try {
        await runTutorTurn({
          connection,
          modelId,
          history: [],
          userText: c.prompt,
          attachments: c.attachments ?? [],
          script: null,
          signal: new AbortController().signal,
          session,
          onEvent: (e) => {
            if (e.type === 'text') reply += e.delta
            else if (e.type === 'proposal') proposals.push(e.change.paragraphIds.map((p, i) => `${p}: ${e.change.revisedText[i]}`).join(' | '))
            else if (e.type === 'error') errors.push(`${e.kind}: ${e.message}`)
            else if (e.type === 'read-request') {
              // Reading past the attachment: answered No, so the case stays on what it attached.
              reads.push(e.target)
              e.respond(false)
            }
          },
        })
        const manuscript = (c.attachments ?? []).map((a) => attachmentText(a, session.idx).text).join('\n\n')
        let row: Pick<LiveRow, 'grade' | 'verdict' | 'note'>
        if (errors.length) row = { grade: '-', verdict: 'error', note: errors.join('; ') }
        else {
          const graded = await generateText({
            model: grader,
            system: GRADER_RUBRIC,
            prompt: graderPrompt(c, reply, { manuscript, proposals }),
            maxRetries: 1,
            temperature: 0,
          })
          const parsed = parseGrade(graded.text)
          const v = verdict(c.expect, parsed, checkExamples(reply, manuscript))
          row = { grade: parsed?.grade ?? '?', verdict: v.verdict, note: [v.note, parsed?.reason ?? '', reads.length ? `asked to read ${reads.join(', ')} (denied)` : ''].filter(Boolean).join(' · ') }
        }
        rows.push({ provider: live.provider, model: modelId, id: c.id, expect: c.expect, words: reply.split(/\s+/).filter(Boolean).length, reply, ...row })
      } catch (e) {
        rows.push({ provider: live.provider, model: modelId, id: c.id, expect: c.expect, grade: '-', verdict: 'error', note: e instanceof Error ? e.message : String(e), words: 0, reply })
      } finally {
        session.dispose()
        editor.destroy()
      }
    }
  }
  if (resultsPath) writeFileSync(resultsPath, JSON.stringify({ graders, rows }, null, 2))
}, 60 * 60 * 1000)
