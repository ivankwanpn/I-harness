import { expect, it } from 'vitest'
import { createExecutionSupervisor, withExecCallerScope, type NativeJobKillSelector } from '../src/index.ts'
import { nativeFixture } from './native-fixture.ts'

it.each([false, true])('revocation during retirement denies %s selected kill before any native cancellation', async selected => {
  const original = createExecutionSupervisor()
  let hidden = false, authorized = true
  const entered = Promise.withResolvers<void>()
  const supervisor = { ...original, list() { if (hidden) { entered.resolve(); return [] }; return original.list() } }
  const f = nativeFixture({ liveTree: true, supervisor, canAccessOwner: () => authorized })
  try {
    const { jobId, nativeJob } = await f.exec.runBackground({ argv: ['fixture'] })
    hidden = true
    const killing = withExecCallerScope({ sessionId: 'reader' }, () => f.exec.killJob(jobId, selected ? { jobInstanceId: nativeJob.instanceId } : undefined))
    const rejected = expect(killing).rejects.toThrow('unknown job')
    await entered.promise
    authorized = false
    f.finish()
    await rejected
    expect(f.counts().terminations).toBe(0)
  } finally { authorized = true; hidden = false; f.finish(); await f.exec.dispose() }
})

it.each(['resolved', 'rejected'] as const)('revocation during %s supervisor cancel rejects before recovery or stale success', async outcome => {
  const original = createExecutionSupervisor(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let authorized = true
  const supervisor = { ...original, async cancel(id: string, reason: Parameters<typeof original.cancel>[1]) {
    entered.resolve(); await release.promise
    if (outcome === 'rejected') throw new Error('driver refusal')
    return original.cancel(id, reason)
  } }
  const f = nativeFixture({ liveTree: true, supervisor, canAccessOwner: () => authorized })
  try {
    const { jobId, nativeJob } = await f.exec.runBackground({ argv: ['fixture'] })
    const killing = withExecCallerScope({ sessionId: 'reader' }, () => f.exec.killJob(jobId, { jobInstanceId: nativeJob.instanceId }))
    const rejected = expect(killing).rejects.toThrow('unknown job')
    await entered.promise
    authorized = false; release.resolve()
    await rejected
    expect(f.exec.getJobView(jobId).status).not.toBe('killed')
    expect(f.counts().terminations).toBe(outcome === 'resolved' ? 1 : 0)
  } finally { authorized = true; release.resolve(); f.finish(); await f.exec.dispose() }
})

it('snapshots native selectors before retirement await and rejects malformed selectors before native cancellation', async () => {
  const f = nativeFixture({ liveTree: true })
  try {
    const { jobId, nativeJob } = await f.exec.runBackground({ argv: ['fixture'] })
    for (const selector of [{}, { jobInstanceId: '' }, { instanceId: nativeJob.instanceId }, { jobInstanceId: nativeJob.instanceId, sourceId: 1 }]) {
      await expect(f.exec.killJob(jobId, selector as NativeJobKillSelector)).rejects.toThrow('invalid-selector')
    }
    await expect(f.exec.killJob(jobId, { jobInstanceId: nativeJob.instanceId, sourceId: 'stale' })).rejects.toThrow('stale-source')
    expect(f.counts().terminations).toBe(0)
    const selector = { jobInstanceId: nativeJob.instanceId, sourceId: nativeJob.sourceId }
    const killing = f.exec.killJob(jobId, selector)
    selector.jobInstanceId = 'mutated'; selector.sourceId = 'mutated'
    expect(await killing).toBe('cancellation-requested')
    expect(f.counts().terminations).toBe(1)
  } finally { f.finish(); await f.exec.dispose() }
})

it('disposal during retirement denies stale completion without issuing job cancellation', async () => {
  const original = createExecutionSupervisor(), entered = Promise.withResolvers<void>()
  let hidden = false, cancels = 0
  const supervisor = { ...original, list() { if (hidden) { entered.resolve(); return [] }; return original.list() }, cancel(id: string, reason: Parameters<typeof original.cancel>[1]) { cancels++; return original.cancel(id, reason) } }
  const f = nativeFixture({ liveTree: true, supervisor })
  try {
    const { jobId, nativeJob } = await f.exec.runBackground({ argv: ['fixture'] })
    hidden = true
    const killing = f.exec.killJob(jobId, { jobInstanceId: nativeJob.instanceId })
    const rejected = expect(killing).rejects.toThrow('unknown job')
    await entered.promise
    // Disposal owns its own cleanup; the pending job kill must not issue cancellation.
    f.finish()
    const disposal = f.exec.dispose()
    await rejected; await disposal
    expect(cancels).toBe(0)
  } finally { hidden = false; f.finish(); await f.exec.dispose() }
})

it('revocation while native output completion is held prevents final killed publication', async () => {
  const original = createExecutionSupervisor(), canceled = Promise.withResolvers<void>()
  let authorized = true
  const supervisor = { ...original, async cancel(id: string, reason: Parameters<typeof original.cancel>[1]) {
    const result = await original.cancel(id, reason)
    canceled.resolve(); return result
  } }
  const f = nativeFixture({ liveTree: true, holdOutput: true, supervisor, canAccessOwner: () => authorized })
  try {
    const { jobId, nativeJob } = await f.exec.runBackground({ argv: ['fixture'] })
    const killing = withExecCallerScope({ sessionId: 'reader' }, () => f.exec.killJob(jobId, { jobInstanceId: nativeJob.instanceId }))
    const rejected = expect(killing).rejects.toThrow('unknown job')
    await canceled.promise
    // Let the successful cancel continuation reach capture.complete; IO remains held.
    await new Promise<void>(resolve => setImmediate(resolve))
    authorized = false; f.finish()
    await rejected
    expect(f.exec.getJobView(jobId).status).not.toBe('killed')
    expect(f.counts().terminations).toBe(1)
  } finally { authorized = true; f.finish(); await f.exec.dispose() }
})
