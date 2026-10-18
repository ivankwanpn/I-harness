import { randomUUID } from 'node:crypto'
import { committedFactSeqs } from '@i-harness/core-session'
import type { SessionAssembly } from '../assembly.ts'
import type { openExecutorDocument } from './managed-document.ts'
import { createGenerationLifecycle } from './generation-actions.ts'

/** The actual cold manual caller opens before assembly/model resolution and
 * keeps its original F1 source alive while Agent borrows the summary grant. */
export async function runManualGeneration(options: {
  ownerSessionId: string
  acquire(): ReturnType<typeof openExecutorDocument>
  assemble(): Promise<SessionAssembly>
  signal: AbortSignal
  instructions?: string
  timeoutMs?: number
  localTestEnabled?: boolean
}) {
  const start = { wall: Date.now(), monotonic: performance.now() }, commandId = randomUUID()
  const attachment = await options.acquire(), action = attachment.factOwner.beginAction(options.signal)
  let assembly: SessionAssembly | undefined
  const lifecycle = createGenerationLifecycle(attachment.session, options.ownerSessionId, action, { enabled: options.localTestEnabled === true, selectedClient: () => assembly?.selectedModel() })
  let generation: Awaited<ReturnType<typeof lifecycle.open>> | undefined
  try {
    const [seq] = committedFactSeqs(await action.facts.metadata.admit({ type: 'command/run', commandId, name: 'compact', ...(options.instructions !== undefined ? { args: options.instructions } : {}), source: { kind: 'user' } }))
    generation = await lifecycle.open('manual', { kind: 'command', seq: seq! }, { signal: options.signal, timeoutMs: options.timeoutMs, start })
    generation.assertOpen()
    assembly = await options.assemble()
    generation.assertOpen()
    return await assembly.compactNow(options.instructions, { generation, signal: options.signal })
  } finally {
    try { await generation?.close(options.signal.aborted ? 'stopped' : 'failed') }
    finally { try { await lifecycle.drain() } finally { action.finish() } }
  }
}
