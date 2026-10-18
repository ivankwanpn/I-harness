import { createAgent } from '../../src/index.ts'
import { createSummaryPort } from '@i-harness/compaction'

/** Existing fixtures explicitly opt into the concrete summary capability. */
export function createAgentWithSummary(ctx: Parameters<typeof createAgent>[0], deps: Parameters<typeof createAgent>[1]) {
  const selected = Object.create(Object.getPrototypeOf(deps), Object.getOwnPropertyDescriptors(deps)) as typeof deps
  if (!selected.summaryFactory) Object.defineProperty(selected, 'summaryFactory', { value: createSummaryPort, enumerable: true, configurable: true })
  return createAgent(ctx, selected)
}
