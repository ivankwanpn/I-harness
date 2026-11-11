import { expect, it } from 'vitest'
import { createCompactionHarness } from './fixtures/engine.ts'
import { history, spyModel, autoConfig } from './fixtures/history.ts'
it('reads the actual live system/schema surface on every probe without rebuilding the owner', async () => {
  const f = spyModel(); let systemPrompt = 'fixed '.repeat(20000)
  const engine = createCompactionHarness({ model: f.model, config: autoConfig, requestShape: () => ({ systemPrompt, tools: [] }) })
  expect(await engine.compact(history())).toMatchObject({ outcome: 'reduced-over-target', compacted: true })
  systemPrompt = 'current small system'
  expect(await engine.compact(history())).toMatchObject({ outcome: 'ready', compacted: true })
  expect(f.requests).toHaveLength(2)
  // A-04: the probe still reads the live surface for admission, but the
  // summary request itself is dedicated and carries neither the main system
  // prompt nor its tool catalogue.
  expect(f.requests[0]?.systemPrompt).toBe('')
  expect(f.requests[0]?.tools).toEqual([])
})
