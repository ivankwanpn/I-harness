import { expect, it } from 'vitest'
import { createCompactionHarness } from './fixtures/engine.ts'
import { history, spyModel, autoConfig } from './fixtures/history.ts'

it('summary request never inherits the main system prompt or tool catalogue (A-04)', async () => {
  const f = spyModel()
  const result = await createCompactionHarness({
    model: f.model,
    config: autoConfig,
    requestShape: () => ({ systemPrompt: 'main-only system', tools: [{ name: 'main-only', description: '', inputSchema: {} }] }),
  }).compact(history())
  expect(result.compacted).toBe(true)
  expect(f.requests[0]).toMatchObject({ systemPrompt: '', tools: [] })
  expect(JSON.stringify(f.requests[0])).not.toContain('main-only system')
  expect(JSON.stringify(f.requests[0])).not.toContain('main-only')
})
