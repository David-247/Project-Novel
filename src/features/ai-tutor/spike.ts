/**
 * DEV-ONLY spike (Phase 5 Task 1; removed in Task 9): proves the AI SDK streams a reply and
 * round-trips a tool call through `ai_fetch` in the real webview, under the closed CSP.
 *
 * Loaded from main.tsx only when `import.meta.env.DEV`, so production bundles never contain it.
 * Run `pnpm tauri dev` with NOVEL_AI_SPIKE_BASE_URL set to an OpenAI-compatible base URL (for
 * example `http://127.0.0.1:11434/v1` for Ollama); Rust then serves the connection `"spike"`
 * and asks the webview to run `window.__tutorSpike()` at startup. It can also be called from the
 * devtools console. Each result line is printed to the terminal by `ai_spike_log`.
 */
import { invoke } from '@tauri-apps/api/core'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { stepCountIs, streamText, tool } from 'ai'
import { z } from 'zod'
import { createTauriFetch } from './net/tauri-fetch'

declare global {
  interface Window {
    __tutorSpike?: (modelId?: string) => Promise<string[]>
  }
}

const log = (line: string) => {
  console.info(`[tutor-spike] ${line}`)
  void invoke('ai_spike_log', { line }).catch(() => {})
}

export async function tutorSpike(modelId = 'spike-model'): Promise<string[]> {
  const lines: string[] = []
  const note = (line: string) => {
    lines.push(line)
    log(line)
  }
  try {
    const provider = createOpenAICompatible({
      name: 'spike',
      baseURL: 'https://provider.invalid',
      fetch: createTauriFetch('spike'),
    })
    const result = streamText({
      model: provider.chatModel(modelId),
      prompt: 'How many words are in the current chapter? Use the tool, then answer in one sentence.',
      tools: {
        count_words: tool({
          description: 'Count the words in the current chapter.',
          inputSchema: z.object({ chapter: z.number() }),
          execute: async ({ chapter }) => ({ chapter, words: 1234 }),
        }),
      },
      stopWhen: stepCountIs(3),
      maxRetries: 0,
    })
    let text = ''
    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') text += part.text
      else if (part.type === 'tool-call') note(`tool-call ${part.toolName} ${JSON.stringify(part.input)}`)
      else if (part.type === 'tool-result') note(`tool-result ${part.toolName} ${JSON.stringify(part.output)}`)
      else if (part.type === 'finish-step') note(`finish-step ${part.finishReason}`)
      else if (part.type === 'error') note(`error ${String((part.error as Error)?.message ?? part.error)}`)
    }
    note(`text ${JSON.stringify(text)}`)
    note('done')
  } catch (e) {
    note(`failed ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`)
  }
  return lines
}

export async function installTutorSpike(): Promise<void> {
  window.__tutorSpike = tutorSpike
  if (await invoke<boolean>('ai_spike_autorun').catch(() => false)) void tutorSpike()
}
