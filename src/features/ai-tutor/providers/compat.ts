import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { Connection } from '../connections/types'
import { probeToolCall, sdkOptions } from './shared'

/** An OpenAI-compatible chat model (`/chat/completions`) for the connection. */
export const compatModel = (c: Connection, modelId: string) =>
  createOpenAICompatible({ name: c.provider, ...sdkOptions(c) }).chatModel(modelId)

export const compatProbe = (c: Connection, modelId: string) => probeToolCall(compatModel(c, modelId))
