import { expect, it } from 'vitest'
import type { TelemetryEvent } from '@i-harness/telemetry'
import { createCompactionHarness } from './fixtures/engine.ts'
import { history, spyModel, autoConfig, autoCap } from './fixtures/history.ts'
import { prepareTextFixture } from './fixtures/checkpoint.ts'
it.each(['success', 'failure', 'skipped'] as const)('observes one %s transaction using actual prepared prices', async outcome => {
  const events: TelemetryEvent[] = [], f = spyModel(), session = history(20, 400)
  if (outcome === 'failure') f.model.stream = async function* () { throw Error('controlled failure') }
  f.model.prepare = prepareTextFixture
  const engine = createCompactionHarness({ model: f.model, maxOutputTokens: outcome === 'skipped' ? undefined : autoCap, config: autoConfig, telemetry: { emit(event) { events.push(event) }, close() {} } })
  const result = await engine.maybeCompact(session)
  const attempts = events.filter(event => event.type === 'compaction/attempt')
  expect(attempts).toHaveLength(1)
  expect(attempts[0]?.data).toMatchObject({ outcome, reason: 'auto', publication: result.publication, outcomeState: result.outcome, attempts: outcome === 'skipped' ? 0 : 1 })
  if (outcome === 'success') expect(attempts[0]!.data.tokensBefore).toBeGreaterThan(attempts[0]!.data.tokensAfter as number)
  expect(attempts[0]!.data.durationMs).toBeGreaterThanOrEqual(0)
})
it('works without a telemetry consumer and emits no operational usage facts for summary output', async () => {
  const session = history()
  expect((await createCompactionHarness({ model: spyModel().model, config: autoConfig }).compact(session)).compacted).toBe(true)
  expect(session.events.some(event => event.type === 'model/exchange-accepted' || event.type === 'context/usage')).toBe(false)
})
