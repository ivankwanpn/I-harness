import { expect, it } from 'vitest'
import { createContext } from '@i-harness/core-plugin'
import { createSession, createNondurableFactOwner, committedFactSeqs } from '@i-harness/core-session'
import { bindPreparedShellLeaf, createToolRegistry, type PreparedShellBodyClaim, type Tool, type ToolDispatchMetadata } from '../src/index.ts'

it('expires each original Shell claim before the next attempt enters', async () => {
  const ctx = createContext(), view = createSession(), owner = createNondurableFactOwner(view)
  const action = owner.beginAction(), source = action.registerSettlementSource(async () => {})
  const registry = createToolRegistry(ctx, { executionOwner: { view, factOwner: owner, context: ctx, sessionId: 'retry' } })
  const claims: PreparedShellBodyClaim[] = []
  let frames = 0
  ctx.onCascade('tools/execute', async (input, next) => {
    const first = ++frames === 1, output = await next()
    if (!first) return output
    const retry = await (input as ToolDispatchMetadata).retryAttempt!()
    if (retry.kind !== 'result') throw Error('Expected acknowledged original retry')
    return retry.value
  })
  const leaf: Tool['execute'] = async (_args, exec) => {
    const claim = entry.enter(exec)!
    if (claims.length) {
      expect(() => claims[0]!.assertCurrent()).toThrow(/expired/)
      expect(() => claims[0]!.consume()).toThrow(/expired/)
    }
    claim.consume()
    expect(() => claim.consume()).toThrow(/consumed/)
    // Controlled cleanup ACK isolates prepared-frame lifetime from native IO.
    claim.retainRetryCleanup(async () => {})
    claims.push(claim)
    return claims.length
  }
  const tool: Tool = { name: 'shell', description: '', inputSchema: {}, execute: leaf }
  const entry = bindPreparedShellLeaf(tool, leaf)
  registry.register(tool)
  try {
    const [callEventSeq] = committedFactSeqs(await action.facts.tools.call({ type: 'tool/call', name: 'shell', callId: 'logical', args: {} }))
    committedFactSeqs(await action.facts.tools.dispatch('logical', { kind: 'prior', seq: callEventSeq!, expectedType: 'tool/call' }))
    const prepared = await registry.prepare({ name: 'shell', args: {} }, action.signal, { session: view, sessionId: 'retry', callId: 'logical', callEventSeq, settlementSource: source })
    expect(await registry.dispatch(prepared)).toBe(2)
    expect(claims).toHaveLength(2)
    expect(claims[0]).not.toBe(claims[1])
    expect(() => claims[1]!.assertCurrent()).toThrow(/expired/)
  } finally { await source.close(); action.finish(); await ctx.scope.unmount() }
})
