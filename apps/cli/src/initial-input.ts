import { randomUUID } from 'node:crypto'
import { openLiteralInputExecution, type openExecutorDocument } from '@i-harness/session-executor'
import type { ModelClient } from '@i-harness/llm-seam'

/** One raw receipt; only the actual oldest pending input starts execution.
 * Later queued inputs receive no action until their real serialized turn. */
export async function openCliInput(options: {
  attachment: Awaited<ReturnType<typeof openExecutorDocument>>; ownerSessionId: string
  text: string; signal: AbortSignal; start: { wall: number; monotonic: number }
  selectedClient(): ModelClient | undefined; localTestEnabled: boolean
  timeoutMs?: number; maxAttempts?: number
}) {
  const { attachment, signal } = options
  await attachment.inbox.admit({ inputId: randomUUID(), text: options.text, delivery: 'queue', intent: 'user', provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'cli.prompt' } }, signal)
  const input = attachment.inbox.pending()[0]
  if (!input) throw new Error('CLI input admission is unavailable')
  const execution = await openLiteralInputExecution({ ...options, input })
  return { ...execution, inputId: input.inputId }
}
