import { createAgent } from '../../src/index.ts'
import { createSummaryPort } from '@i-harness/compaction'

/** Existing fixtures explicitly opt into the concrete summary capability. */
export function createAgentWithSummary(ctx: Parameters<typeof createAgent>[0], deps: Parameters<typeof createAgent>[1]) {
  // Forward to the caller without copying its mutable data or changing getter
  // and callback receivers. The empty target also supports frozen host objects.
  const selected = new Proxy({} as typeof deps, { get(_target, key) {
    const value = Reflect.get(deps, key, deps) ?? (key === 'summaryFactory' ? createSummaryPort : undefined)
    return typeof value === 'function' ? value.bind(deps) : value
  } })
  return createAgent(ctx, selected)
}
