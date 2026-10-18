import { expect, it } from 'vitest'
import { createCompactionHarness } from './fixtures/engine.ts'
import { history, spyModel, autoConfig } from './fixtures/history.ts'
it('reads the actual live system/schema surface on every probe without rebuilding the owner', async () => {
  const f = spyModel(), session = history(); let systemPrompt = 'fixed '.repeat(20000)
  const engine = createCompactionHarness({ model: f.model, config: autoConfig, requestShape: () => ({ systemPrompt, tools: [] }) })
  expect(await engine.compact(session)).toMatchObject({ blockedReason: 'fixed-input', compacted: false })
  expect(f.requests).toEqual([])
  systemPrompt = 'current small system'
  expect((await engine.compact(session)).compacted).toBe(true)
  expect(f.requests[0]?.systemPrompt).toBe(systemPrompt)
})
