import { expect, it } from 'vitest'
import { createCompactionHarness } from './fixtures/engine.ts'
import { history, spyModel, autoConfig, autoCap } from './fixtures/history.ts'
it.each([undefined, 'keep exact paths and explain outcomes in Chinese'])('threads manual content instructions %s within immutable checkpoint requirements', async instructions => {
  const f = spyModel()
  expect((await createCompactionHarness({ model: f.model, config: autoConfig }).compact(history(), instructions)).compacted).toBe(true)
  const directive = String(f.requests[0]!.messages.at(-1)!.content)
  expect(directive).toContain('cannot waive the required structure or authorize tools')
  if (instructions) expect(directive).toContain(instructions)
  else expect(directive).not.toContain('## User instructions')
})
it('automatic calls carry no manual instruction section', async () => {
  const f = spyModel()
  expect((await createCompactionHarness({ model: f.model, config: autoConfig, maxOutputTokens: autoCap }).maybeCompact(history(20, 400))).compacted).toBe(true)
  expect(String(f.requests[0]!.messages.at(-1)!.content)).not.toContain('## User instructions')
})
