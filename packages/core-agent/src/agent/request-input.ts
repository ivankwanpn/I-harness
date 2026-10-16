import { createHash } from 'node:crypto'
import { renderConversation, copyConversationData } from '@i-harness/core-session'
import type { ContextSnapshot } from '@i-harness/context-engine'
import { assertMessagesFromLog, type LLMRequest } from '@i-harness/llm-seam'

/** Construct only from the captured projection and surface. Real-step hooks,
 * claims, telemetry and prefix history stay with the live step owner.
 */
export function buildContextRequest(
  input: Pick<ContextSnapshot, 'conversation' | 'surface'>,
  options: { sessionId?: string; signal?: AbortSignal; requestScope?: LLMRequest['requestScope'] },
): LLMRequest {
  const messages = renderConversation(input.conversation)
  assertMessagesFromLog(messages, input.conversation)
  const { surface } = input, { sessionId, signal, requestScope } = options
  return {
    requestScope,
    retryOutput: 'discard',
    ...(sessionId === undefined ? {} : { sessionId }),
    messages,
    tools: surface.tools.map(tool => ({ ...tool, inputSchema: copyConversationData<unknown>(tool.inputSchema) })),
    systemPrompt: surface.systemPrompt,
    ...(sessionId === undefined ? {} : { promptCache: { key: `ih_${createHash('sha256').update(sessionId).digest('hex').slice(0, 48)}` } }),
    // Preserve the host ceiling until actual adapter preparation and admission.
    ...(surface.maxOutputTokens !== undefined ? { maxOutputTokens: surface.maxOutputTokens } : {}),
    // The adapter owns the reasoning vocabulary and transport cancellation.
    ...(surface.reasoningEffort !== undefined ? { reasoningEffort: surface.reasoningEffort } : {}),
    ...(signal !== undefined ? { signal } : {}),
  }
}
