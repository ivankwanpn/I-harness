import { committedFactSeqs } from '@i-harness/core-session'
import type { SessionAssembly } from '../../src/assembly.ts'

/**
 * Run the real durable `spawn_agent` path from a test without a model turn.
 *
 * The Task leaf only accepts its original prepared body: a synthetic direct
 * `tools.execute` has no managed action, call identity or settlement source, so
 * the product correctly refuses it with `Original prepared task caller
 * unavailable`. This helper creates the same pieces the agent tool batch would:
 * one action, the exact tool/call + dispatch facts, a settlement source, then
 * prepare + dispatch through the public registry.
 */
export async function spawnDurable(
  assembly: SessionAssembly,
  sessionId: string,
  args: Record<string, unknown>,
  callId = 'spawn-' + Math.random().toString(36).slice(2),
): Promise<{ output: unknown }> {
  const action = assembly.factOwner.beginAction()
  let source: ReturnType<typeof action.registerSettlementSource> | undefined
  try {
    const [seq] = committedFactSeqs(await action.facts.tools.call({ type: 'tool/call', callId, name: 'spawn_agent', args }))
    if (seq === undefined) throw new Error('Original spawn call fact did not commit')
    committedFactSeqs(await action.facts.tools.dispatch(callId, { kind: 'prior', seq, expectedType: 'tool/call' }))
    source = action.registerSettlementSource(async () => {})
    const prepared = await assembly.tools.prepare({ name: 'spawn_agent', args }, action.signal, {
      session: assembly.session, sessionId, callId, callEventSeq: seq, settlementSource: source,
    })
    return { output: await assembly.tools.dispatch(prepared) }
  } finally {
    try { await source?.close() } catch { /* The fixture only asserts the spawn contract. */ }
    action.finish()
  }
}
