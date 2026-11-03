import { expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { createSession, encodeExecFrameRecord, type ManagedArtifactRef } from '@i-harness/core-session'
import { readExecFramePage } from '../../context-output/src/artifact/exec-reader.ts'
import { createJobOutputTool } from '../src/tools/status.ts'
import { withReportPolicy, SHIPPING_REPORT_POLICY } from '../src/report-policy.ts'
import type { SubagentToolDeps } from '../src/tools/types.ts'

// Isolated adapter fault controls; genuine lifecycle/ownership is qualified by gateway fixture.
function fixture(raw = Buffer.from('\uFEFFabc😀\n'), completeness: ManagedArtifactRef['completeness'] = 'complete') {
  const body = Buffer.from('IHEXEC01\n' + encodeExecFrameRecord({ channel: 'stdout', frame: 3, offset: 0, end: true, data: raw.toString('base64') }))
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
  const ref: ManagedArtifactRef = { version: 1, id: 'ctxv1_' + 'a'.repeat(64), revision: 'b'.repeat(64), codec: 'exec-frames-v1', contentDigest: sha(body), encodedBytes: body.length, completeness }
  const dependency = { kind: 'exec-frames', sourceId: 'process:execution-1', retention: { kind: 'artifact', ref } }
  const identity = { version: 1, instanceId: 'instance-A', jobId: 'bash-1', sourceId: dependency.sourceId, ownerSessionId: 'owner' }
  const view = { nativeJob: identity, id: 'bash-1', status: 'completed', stdout: 'wrong preview', stderr: '' }
  const service = {
    getJobView: vi.fn(() => view), getOutput: vi.fn(() => { throw new Error('legacy observing read forbidden') }),
    subscribeJob: vi.fn(() => () => {}),
    observeJobOutput: vi.fn(async () => ({ view, nativeJob: identity, source: { kind: 'retained-summary', dependency, summary: { version: 1, stdout: { bytes: raw.length, sha256: sha(raw) }, stderr: { bytes: 0, sha256: sha(Buffer.alloc(0)) }, totalRawBytes: raw.length, completeness } } })),
    readJobOutputFrames: vi.fn(async (_id, q) => ({ kind: 'page', dependency, page: await readExecFramePage(ref, q, async (o, n) => body.subarray(o, o + n)) })),
  }
  const deps = { exec: service, jobs: { read: vi.fn(() => { throw new Error('unknown job') }) }, table: { entries: () => new Map() }, reportPolicy: SHIPPING_REPORT_POLICY } as unknown as SubagentToolDeps
  const factory = createJobOutputTool(deps), tool = withReportPolicy(factory, deps)
  const call = async (args: Record<string, unknown> = {}) => tool.execute({ job_id: 'bash-1', ...args }, { session: createSession() }) as Promise<any>
  return { raw, sha, ref, view, identity, service, deps, tool, factory, call }
}
it('executes the trusted factory invocation once, preserves BOM/raw SHA, and bounds no-policy native calls', async () => {
  const f = fixture(), value = await f.call()
  expect(value.text).toBe(f.raw.toString()); expect(value.digest).toBe(f.sha(f.raw)); expect(value.total_bytes).toBe(f.raw.length)
  expect(f.service.observeJobOutput).toHaveBeenCalledTimes(1); expect(f.service.getOutput).not.toHaveBeenCalled()
  expect(value.full_result.args.viaCatalog).toBeUndefined()
  expect(value.text_result.args).toMatchObject({ job_instance_id: 'instance-A', source_id: f.identity.sourceId, offset_bytes: f.raw.length })
  f.deps.reportPolicy = undefined
  const plain = createJobOutputTool(f.deps)
  expect((await plain.execute({ job_id: 'bash-1' }, {})) as any).toMatchObject({ digest: f.sha(f.raw), text: f.raw.toString() })
  expect((plain.inputSchema as any).properties).toHaveProperty('job_instance_id')
})
it.each([
  [{ offset_bytes: 0 }, 'instance-required'], [{ digest: 'f'.repeat(64) }, 'instance-required'],
  [{ source_id: 'old' }, 'instance-required'], [{ job_instance_id: 'old' }, 'stale-instance'],
  [{ job_instance_id: 'instance-A', source_id: 'old' }, 'stale-source'], [{ cursor: '' }, 'unsupported-selector'],
  [{ field: 'error', job_instance_id: 'instance-A' }, 'unsupported-selector'], [{ offset_bytes: Number.MAX_SAFE_INTEGER + 1 }, 'invalid-selector'],
  [{ digest: 'wrong' }, 'invalid-selector'], [{ max_output_bytes: 1023 }, 'budget'],
] as const)('preflights %j before any observing/wait side effect', async (args, code) => {
  const f = fixture(), value = await f.call({ ...args, wait: true })
  expect(value.error.code).toBe(code)
  expect(f.service.observeJobOutput).not.toHaveBeenCalled(); expect(f.service.readJobOutputFrames).not.toHaveBeenCalled(); expect(f.service.subscribeJob).not.toHaveBeenCalled()
})
it('rejects wrong digest after summary and before text reads; next invocation has fresh args', async () => {
  const f = fixture()
  expect((await f.call({ job_instance_id: 'instance-A', digest: 'f'.repeat(64) })).error.code).toBe('stale-digest')
  expect(f.service.readJobOutputFrames).not.toHaveBeenCalled()
  expect((await f.call({ job_instance_id: 'instance-A', digest: f.sha(f.raw), offset_bytes: 3 })).text).toBe('abc😀\n')
})
it.each(['complete', 'source-limited', 'capture-canceled', 'producer-incomplete'] as const)('preserves %s raw scope and status', async completeness => {
  const f = fixture(Buffer.from('small'), completeness), value = await f.call()
  expect(value).toMatchObject({ completeness, status: 'completed', total_bytes: 5, truncated: completeness !== 'complete' })
})
it('bounds escape-heavy native output and oversized identities by whole groups', async () => {
  const f = fixture(Buffer.from('"\n\\\t'.repeat(1000)))
  const v = await f.call({ max_output_bytes: 2048 })
  expect(Buffer.byteLength(JSON.stringify(v))).toBeLessThanOrEqual(2048)
  expect(v.next_offset_bytes).toBeGreaterThan(0)
  f.identity.instanceId = '"'.repeat(9000)
  const refused = await f.call({ max_output_bytes: 1024 })
  expect(refused.error.code).toBe('metadata-budget'); expect(refused.native_job).toBeUndefined()
  expect(Buffer.byteLength(JSON.stringify(refused))).toBeLessThanOrEqual(1024)
})
it('binary stdout uses raw fallback with verified totals and no invented exact offsets', async () => {
  const value = await fixture(Buffer.from([255, 0])).call()
  expect(value).toMatchObject({ display_only: true, total_bytes: 2, error: { code: 'text-view-unavailable' }, full_result: { tool: 'context_output_read' } })
  expect(value.offset_bytes).toBeUndefined(); expect(value.next_offset_bytes).toBeUndefined()
})
it('native-looking child payload remains on compatibility report composition', async () => {
  const f = fixture()
  f.deps.jobs.read = vi.fn(() => ({ status: 'completed', output: 'child payload native_job' })) as any
  const value = await f.call()
  expect(value.text).toBe('child payload native_job'); expect(value.native_job).toBeUndefined()
  expect(f.service.observeJobOutput).not.toHaveBeenCalled()
})
it('pending native wait yields to steer without observing preview bytes or paging', async () => {
  const { Inbox } = await import('@i-harness/core-session')
  const f = fixture(), session = createSession()
  f.view.status = 'running'
  f.service.observeJobOutput.mockImplementation(async () => ({ view: f.view, nativeJob: f.identity, source: { kind: 'pending' } }) as any)
  const result = f.tool.execute({ job_id: 'bash-1', wait: true }, { session })
  new Inbox(session).admit({ inputId: 'steer', text: 'refocus', intent: 'user', delivery: 'steer' })
  expect(await result).toMatchObject({ status: 'running', source: { kind: 'pending' }, display_only: true, yielded: true, yield_reason: 'user-steer' })
  expect(f.service.getOutput).not.toHaveBeenCalled(); expect(f.service.readJobOutputFrames).not.toHaveBeenCalled()
})
it('pending digest remains unverified and raw paging errors never change command status', async () => {
  const f = fixture()
  f.service.observeJobOutput.mockImplementationOnce(async () => ({ view: f.view, nativeJob: f.identity, source: { kind: 'pending' } }) as any)
  expect(await f.call({ job_instance_id: f.identity.instanceId, digest: f.sha(f.raw) })).toMatchObject({ error: { code: 'output-pending' }, status: 'completed' })
  f.service.readJobOutputFrames.mockRejectedValueOnce(new Error('private attacker exception text'))
  const failed = await f.call()
  expect(failed).toMatchObject({ error: { code: 'output-unavailable' }, status: 'completed' })
  expect(JSON.stringify(failed)).not.toContain('private attacker')
})
it('rejects replacement or abort after awaited observation before publication', async () => {
  const f = fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const original = f.service.observeJobOutput.getMockImplementation()!
  f.service.observeJobOutput.mockImplementation(async () => { entered.resolve(); await release.promise; return original() })
  const reading = f.call()
  await entered.promise
  f.view.nativeJob = { ...f.identity, instanceId: 'replacement' }
  release.resolve()
  await expect(reading).rejects.toThrow('no longer current')
  expect(f.service.readJobOutputFrames).not.toHaveBeenCalled()
})
it('non-native identity selectors refuse even when legacy digest/field selectors are present', async () => {
  const f = fixture()
  f.deps.jobs.read = vi.fn(() => ({ status: 'completed', output: 'native_job attacker payload' })) as any
  expect(await f.call({ job_instance_id: 'x', digest: 'wrong', field: 'text' })).toMatchObject({ error: { code: 'unsupported-selector' } })
  expect(f.service.observeJobOutput).not.toHaveBeenCalled()
})
it.each(['not-found', 'stale', 'unauthorized', 'corrupt', 'range', 'budget', 'unavailable'] as const)('preserves finite mapped page-read reason %s separately from native command status', async reason => {
  const f = fixture()
  f.service.readJobOutputFrames.mockResolvedValueOnce({ kind: 'unavailable', reason } as any)
  expect(await f.call()).toMatchObject({ error: { code: 'output-unavailable' }, status: 'completed', read_failure: { kind: 'unavailable', reason } })
})
it('native service lacking passive capability refuses without fabricating command status', async () => {
  const f = fixture()
  f.deps.exec.getJobView = undefined
  const value = await f.call()
  expect(value).toMatchObject({ error: { code: 'native-capability-unavailable' } })
  expect(value.status).toBeUndefined()
  expect(f.service.observeJobOutput).not.toHaveBeenCalled(); expect(f.service.getOutput).not.toHaveBeenCalled()
})
it('rejects a complete-ref change from the authenticated text page without publishing bytes', async () => {
  const f = fixture()
  const original = f.service.readJobOutputFrames.getMockImplementation()!
  f.service.readJobOutputFrames.mockImplementationOnce(async (...args) => {
    const result = await original(...args)
    result.page.ref = { ...result.page.ref, completeness: 'source-limited' }
    return result
  })
  const value = await f.call()
  expect(value).toMatchObject({ status: 'completed', error: { code: 'output-unavailable' } })
  expect(value.text).toBeUndefined()
})
