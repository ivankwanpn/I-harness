import { createAgentProcesses } from '../src/agent-processes.ts'
import { createAgentProcessReadRunner } from '../src/agent-process-read.ts'
import { createConversationResultReader } from '../src/result-reader.ts'
import { createSessionManagementFence } from '../src/session-management-fence.ts'
import { mkdtemp, mkdir, rm, stat, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { createJsonlTaskTransitionCoordinator } from '@i-harness/session-persistence-jsonl/internal/task-document-factory'
import { taskDocumentStorageContract } from '@i-harness/subagent/internal/task-storage-contract'
import { createSessionService } from '@i-harness/session-executor'
import type { ResultDependency } from '@i-harness/core-session'
import { createNativeContextRuntime } from '../src/context-runtime.ts'
import { lookupProcessReadContext } from '@i-harness/session-persistence/internal/process-read-context'

const trace = vi.hoisted(() => ({ path: '', active: false, reads: [] as { length: number; position: number; bytes: number }[], fullReads: 0, builds: 0, decodes: 0, snapshots: 0, gatewayBuilds: 0, afterRead: undefined as ((path: string) => Promise<void>) | undefined }))
vi.mock('../src/saved-process-index.ts', async original => {
  const real = await original<typeof import('../src/saved-process-index.ts')>()
  return { ...real, buildObservedSavedProcessIndex(...args: Parameters<typeof real.buildObservedSavedProcessIndex>) { if (trace.active) trace.gatewayBuilds++; return real.buildObservedSavedProcessIndex(...args) } }
})
vi.mock('../../session-persistence/src/coordinator-factory.ts', async original => {
  const real = await original<typeof import('../../session-persistence/src/coordinator-factory.ts')>()
  return { ...real, createSessionCoordinatorCore(...args: Parameters<typeof real.createSessionCoordinatorCore>) {
    const coordinator = real.createSessionCoordinatorCore(...args), snapshot = coordinator.snapshot!
    coordinator.snapshot = (...input) => { if (trace.active) trace.snapshots++; return Reflect.apply(snapshot, coordinator, input) }
    return coordinator
  } }
})
vi.mock('@i-harness/core-session', async original => {
  const real = await original<typeof import('@i-harness/core-session')>()
  return { ...real, readFactJournal(...args: Parameters<typeof real.readFactJournal>) { if (trace.active) trace.decodes++; return real.readFactJournal(...args) } }
})
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, readFile: async (...args: Parameters<typeof fs.readFile>) => { if (trace.active && String(args[0]) === trace.path) trace.fullReads++; return fs.readFile(...args) }, open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args), read = handle.read.bind(handle)
    handle.read = (async (...input: [Buffer, number, number, number]) => { const result = await read(...input); if (trace.active && String(args[0]) === trace.path) trace.reads.push({ length: input[2], position: input[3], bytes: result.bytesRead }); await trace.afterRead?.(String(args[0])); return result }) as typeof handle.read
    return handle
  } }
})
vi.mock('../../session-persistence/src/coordinator/process-read-visibility.ts', async original => {
  const real = await original<typeof import('../../session-persistence/src/coordinator/process-read-visibility.ts')>()
  return { ...real, createProcessReadVisibility() { if (trace.active) trace.builds++; return real.createProcessReadVisibility() } }
})

it('reads real catalog members through the injected native service without visibility rescans', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-native-bridge-')), sessions = join(root, 'sessions'), settings = join(root, 'settings.json')
  await mkdir(sessions); await writeFile(settings, '{}')
  const coordinator = createJsonlTaskTransitionCoordinator(sessions, { lock: { enabled: true } }, taskDocumentStorageContract); await coordinator.create({ sessionId: 's' })
  let revision = 'one'
  const visibleRefsFor = vi.fn(async () => []), getter = () => ({ revision }), resolveScope = async () => getter
  const native = await createNativeContextRuntime({ workspace: root, storageRoot: join(root, 'native'), coordinator, projectFor: async () => ({ revision: 'one' }), resultReadScopeFor: resolveScope, visibleRefsFor })
  const source = await native.sourceFor('s'), output = native.contextOutput, owner = { operationId: 'member', sessionId: 's', callId: 'member', source }
  const memberSink = await output.beginResult(output.registerResultScope(owner, () => true), 'exec-frames-v1')
  await memberSink.write(Buffer.from('IHEXEC01\n{"channel":"stdout","frame":0,"offset":0,"end":true,"data":"eA=="}\n'))
  const member = await memberSink.finish('complete'); if (member.kind !== 'committed') throw new Error('member refused')
  const entries: ResultDependency[] = [{ kind: 'exec-frames', sourceId: 'native', retention: { kind: 'artifact', ref: member.ref } }]
  const scope = output.registerResultDependencyScope({ ...owner, operationId: 'catalog', callId: 'catalog' }, () => true, entries)
  const sink = await output.beginResult(scope, 'json-utf8-v1'); await sink.write(Buffer.from(JSON.stringify({ version: 1, kind: 'result-dependencies', entries })))
  const catalog = await sink.finish('complete'); if (catalog.kind !== 'committed') throw new Error('catalog refused')
  expect(await output.settleResultDependencyMembership(scope, catalog.ref)).toBe('ready')
  await coordinator.append('s', [{ type: 'tool/call', callId: 'c', name: 'read', args: {} }, { type: 'tool/result', callId: 'c', name: 'read', envelope: { version: 1, execution: { outcome: 'succeeded', dispatch: 'dispatched' }, preview: '', media: [], retention: { kind: 'unavailable', reason: 'quota', observedEncodedBytes: 0 }, dependencies: { kind: 'artifact-set', ref: catalog.ref, count: 1 } } }])
  const nativeJob = { version: 1, jobId: 'bash-1', instanceId: 'probe-native-instance', ownerSessionId: 's', sourceId: 'native' }
  const digest = (text: string) => createHash('sha256').update(text).digest('hex')
  const dtoValue = { job_id: 'bash-1', native_job: nativeJob, status: 'completed', source: { kind: 'retained-summary' }, scope: 'captured', completeness: 'complete', total_bytes: 1, stderr_total_bytes: 0, total_raw_bytes: 1, digest: digest('x'), stderr_digest: digest(''), digest_format: 'sha256-raw-v1', text: 'x', offset_bytes: 0, next_offset_bytes: 1, truncated: false,
    full_result: { tool: 'context_output_read', args: { ref: member.ref, maxBytes: 32768 }, access: 'catalog-required', catalog_from: 'envelope.dependencies.ref' } }
  const dtoSink = await output.beginResult(output.registerResultScope({ ...owner, operationId: 'dto', callId: 'dto' }, () => true), 'json-utf8-v1')
  await dtoSink.write(Buffer.from(JSON.stringify(dtoValue))); const dto = await dtoSink.finish('complete'); if (dto.kind !== 'committed') throw new Error('DTO refused')
  const inline = { job_id: 'bash-1', native_job: nativeJob }
  await coordinator.append('s', [
    { type: 'tool/call', callId: 'start', name: 'shell', args: {} },
    { type: 'tool/result', callId: 'start', name: 'shell', envelope: { version: 1, execution: { outcome: 'succeeded', dispatch: 'dispatched' }, preview: '', media: [], retention: { kind: 'inline', value: inline, encodedBytes: Buffer.byteLength(JSON.stringify(inline)) } } },
    { type: 'tool/call', callId: 'dto', name: 'job_output', args: { job_id: 'bash-1', job_instance_id: nativeJob.instanceId } },
    { type: 'tool/result', callId: 'dto', name: 'job_output', envelope: { version: 1, execution: { outcome: 'succeeded', dispatch: 'dispatched' }, preview: 'non-authority', media: [], retention: { kind: 'artifact', ref: dto.ref }, dependencies: { kind: 'artifact-set', ref: catalog.ref, count: 1 } } },
  ])
  // Same owner, genuine catalog membership and bytes, contradictory selected native source.
  const wrongNative = { ...nativeJob, jobId: 'bash-2', instanceId: 'wrong-source-instance', sourceId: 'selected-source-A' }
  const wrongValue = { ...dtoValue, job_id: wrongNative.jobId, native_job: wrongNative, full_result: { ...dtoValue.full_result, args: { ...dtoValue.full_result.args, ref: { ...member.ref } } } }
  const wrongSubmit = { job_id: wrongNative.jobId, native_job: wrongNative }
  await coordinator.append('s', [
    { type: 'tool/call', callId: 'wrong-start', name: 'shell', args: {} },
    { type: 'tool/result', callId: 'wrong-start', name: 'shell', envelope: { version: 1, execution: { outcome: 'succeeded', dispatch: 'dispatched' }, preview: '', media: [], retention: { kind: 'inline', value: wrongSubmit, encodedBytes: Buffer.byteLength(JSON.stringify(wrongSubmit)) } } },
    { type: 'tool/call', callId: 'wrong-inline', name: 'job_output', args: { job_id: wrongNative.jobId, job_instance_id: wrongNative.instanceId } },
    { type: 'tool/result', callId: 'wrong-inline', name: 'job_output', envelope: { version: 1, execution: { outcome: 'succeeded', dispatch: 'dispatched' }, preview: '', media: [], retention: { kind: 'inline', value: wrongValue, encodedBytes: Buffer.byteLength(JSON.stringify(wrongValue)) }, dependencies: { kind: 'artifact-set', ref: catalog.ref, count: 1 } } },
  ])
  const reader = createSessionService({ workspace: root, coordinator, sessionId: 's', contextOutput: output, contextOutputSourceFor: native.sourceFor, contextOutputSettingsPath: settings, resultReadScopeFor: resolveScope })
  try {
    trace.path = join(sessions, 's.jsonl'); const historyBytes = (await stat(trace.path)).size; trace.reads = []; trace.fullReads = 0; trace.builds = 0; trace.decodes = 0; trace.active = true
    const value = await coordinator.withProcessReadObservation!('s', { documentKeys: [] }, async o => {
      for (let n = 0; n < 3; n++) { expect(await reader.readResultPage!('s', { ref: member.ref, viaCatalog: catalog.ref })).toMatchObject({ frames: [{ data: 'eA==' }] }); await o.check() }
      return 'candidate'
    }, async (candidate, o) => { o.assertCurrent(); return candidate })
    trace.active = false
    expect(value).toBe('candidate'); expect(trace.fullReads).toBe(0); expect(trace.snapshots).toBe(0); expect(visibleRefsFor).not.toHaveBeenCalled()
    expect(trace.builds).toBe(1); expect(trace.decodes).toBe(1)
    expect(trace.reads.filter(read => read.position === 0 && read.length === historyBytes + 1 && read.bytes === historyBytes)).toHaveLength(2)
    console.log(JSON.stringify({ control: 'native-process-cost', pages: 3, historyBytes, witnessBytePasses: 2, journalDecodes: trace.decodes, visibilityBuilds: trace.builds, profileReads: trace.reads.filter(read => read.length === 65536).length, profileBytes: trace.reads.filter(read => read.length === 65536).reduce((sum, read) => sum + read.bytes, 0), fullReadFileCalls: trace.fullReads, visibleRefsCalls: visibleRefsFor.mock.calls.length, catalogAndPinIO: 'actual, not counted by this probe' }))
    trace.reads = []; trace.fullReads = 0; trace.builds = 0; trace.decodes = 0; trace.gatewayBuilds = 0; trace.snapshots = 0
    const fence = createSessionManagementFence(), isConversation = async () => true
    const conversationRead = createConversationResultReader(coordinator, reader, isConversation, fence)!
    let selectedPages = 0
    const processes = createAgentProcesses(coordinator, reader, { runRead: createAgentProcessReadRunner({ coordinator, service: reader, isConversation, fence, resultReadScopeFor: resolveScope,
      readResultPage: async (id, query) => { selectedPages++; return conversationRead(id, query) } }) })
    trace.active = true
    const selected = await processes.jobOutput('s', 'bash-1', { backend: 'shell', mode: 'frames', instanceId: nativeJob.instanceId })
    trace.active = false
    expect(selected).toMatchObject({ kind: 'frames', page: { frames: [{ data: 'eA==' }] } })
    expect(selectedPages).toBe(3)
    expect(trace.fullReads).toBe(0); expect(trace.snapshots).toBe(0); expect(trace.gatewayBuilds).toBe(1); expect(trace.builds).toBe(1); expect(trace.decodes).toBe(1)
    expect(trace.reads.filter(read => read.position === 0 && read.length === historyBytes + 1 && read.bytes === historyBytes)).toHaveLength(2)
    console.log(JSON.stringify({ control: 'gateway-selected-dto-catalog-body', selectedPages, historyBytes, witnessBytePasses: 2, gatewayBuilds: trace.gatewayBuilds, visibilityBuilds: trace.builds, journalDecodes: trace.decodes, snapshots: trace.snapshots, fullReadFileCalls: trace.fullReads, catalogAndPinIO: 'original membership IO remains separately required' }))
    selectedPages = 0; trace.reads = []; trace.fullReads = 0; trace.snapshots = 0; trace.gatewayBuilds = 0; trace.builds = 0; trace.decodes = 0; trace.active = true
    const passiveRows = await processes.read('s')
    trace.active = false
    expect(passiveRows.jobs).toContainEqual(expect.objectContaining({ jobId: 'bash-1', outputAvailable: true, live: false, canCancel: false }))
    expect(selectedPages).toBe(0); expect(reader.hasAssembly('s')).toBe(false); expect(trace.snapshots).toBe(0); expect(trace.fullReads).toBe(0); expect(trace.gatewayBuilds).toBe(1)
    console.log(JSON.stringify({ control: 'gateway-passive-process-list', artifactPages: selectedPages, gatewayBuilds: trace.gatewayBuilds, snapshots: trace.snapshots, fullReadFileCalls: trace.fullReads, hasAssembly: reader.hasAssembly('s') }))
    let wrongSourceBodyPages = 0, wrongSourceCatalogPages = 0
    const sourceChecked = createAgentProcesses(coordinator, reader, { runRead: createAgentProcessReadRunner({ coordinator, service: reader, isConversation, fence, resultReadScopeFor: resolveScope,
      readResultPage: async (id, query) => { if (query.ref.codec === 'exec-frames-v1') wrongSourceBodyPages++; else wrongSourceCatalogPages++; return conversationRead(id, query) } }) })
    expect(await sourceChecked.jobOutput('s', wrongNative.jobId, { backend: 'shell', mode: 'frames', instanceId: wrongNative.instanceId })).toEqual({ kind: 'unavailable', reason: 'unavailable' })
    expect(wrongSourceCatalogPages).toBe(1); expect(wrongSourceBodyPages).toBe(0)
    let publishBodies = 0
    trace.reads = []; trace.active = true
    trace.afterRead = async path => { if (path.endsWith('body')) publishBodies++ }
    try {
      await expect(coordinator.withProcessReadObservation!('s', { documentKeys: [] }, async () => 'cached', async (value, o) => {
        o.assertCurrent(); expect(lookupProcessReadContext(coordinator, 's')!.containsVisibleResult(catalog.ref)).toBe(true)
        expect(await reader.readResultPage!('s', { ref: member.ref, viaCatalog: catalog.ref })).toMatchObject({ kind: 'unavailable' }); return value
      })).rejects.toThrow()
      expect(publishBodies).toBe(0)
      expect(trace.reads.filter(read => read.position === 0 && read.length === historyBytes + 1 && read.bytes === historyBytes)).toHaveLength(2)
    } finally { trace.afterRead = undefined; trace.active = false }
    const foreign = { ...member.ref, id: `ctxv1_${'f'.repeat(64)}` }
    await expect(coordinator.withProcessReadObservation!('s', { documentKeys: [] }, async () => {
      expect(await reader.readResultPage!('s', { ref: foreign, viaCatalog: catalog.ref })).toMatchObject({ kind: 'unavailable' }); return 'discard'
    }, async result => result)).rejects.toThrow()
    const copied = createSessionService({ workspace: root, coordinator, sessionId: 's', contextOutput: { ...output }, contextOutputSourceFor: native.sourceFor, contextOutputSettingsPath: settings, resultReadScopeFor: resolveScope })
    try {
      await expect(coordinator.withProcessReadObservation!('s', { documentKeys: [] }, async () => {
        expect(await copied.readResultPage!('s', { ref: member.ref, viaCatalog: catalog.ref })).toMatchObject({ kind: 'unavailable' }); return 'discard'
      }, async result => result)).rejects.toThrow()
    } finally { await copied.close() }
    for (const mode of ['scope', 'pin'] as const) {
      let restoredPin: { path: string; bytes: Buffer } | undefined, reachedBody = false, published = false
      try {
        trace.afterRead = async path => {
          if (!path.includes(member.ref.id) || !path.endsWith('body')) return
          trace.afterRead = undefined; reachedBody = true
          if (mode === 'scope') { revision = 'two'; return }
          const pin = join(dirname(path), 'pins', createHash('sha256').update('s').digest('hex') + '.json')
          restoredPin = { path: pin, bytes: await readFile(pin) }; await rm(pin)
        }
        await expect(coordinator.withProcessReadObservation!('s', { documentKeys: [] }, async () => {
          expect(await reader.readResultPage!('s', { ref: member.ref, viaCatalog: catalog.ref })).toMatchObject({ kind: 'unavailable' }); return 'cached'
        }, async result => { published = true; return result })).rejects.toThrow()
        expect(reachedBody).toBe(true); expect(published).toBe(false)
      } finally { trace.afterRead = undefined; revision = 'one'; if (restoredPin) await writeFile(restoredPin.path, restoredPin.bytes) }
    }
    const originalMethod = output.readExecResult
    try {
      output.readExecResult = async () => { throw new Error('Substituted page method ran') }
      let published = false
      await expect(coordinator.withProcessReadObservation!('s', { documentKeys: [] }, async () => {
        expect(await reader.readResultPage!('s', { ref: member.ref, viaCatalog: catalog.ref })).toMatchObject({ kind: 'unavailable' }); return 'cached'
      }, async result => { published = true; return result })).rejects.toThrow()
      expect(published).toBe(false)
    } finally { output.readExecResult = originalMethod }
    const unlistedSink = await output.beginResult(output.registerResultScope({ ...owner, operationId: 'unlisted', callId: 'unlisted' }, () => true), 'exec-frames-v1')
    await unlistedSink.write(Buffer.from('IHEXEC01\n{"channel":"stdout","frame":0,"offset":0,"end":true,"data":"eQ=="}\n'))
    const unlisted = await unlistedSink.finish('complete'); if (unlisted.kind !== 'committed') throw new Error('unlisted fixture refused')
    let memberPublished = false
    await expect(coordinator.withProcessReadObservation!('s', { documentKeys: [] }, async () => {
      expect(await reader.readResultPage!('s', { ref: unlisted.ref, viaCatalog: catalog.ref })).toMatchObject({ kind: 'unavailable' }); return 'cached'
    }, async result => { memberPublished = true; return result })).rejects.toThrow()
    expect(memberPublished).toBe(false)
    const foreignCoordinator = createJsonlTaskTransitionCoordinator(sessions, { lock: { enabled: true } }, taskDocumentStorageContract)
    const foreignReader = createSessionService({ workspace: root, coordinator: foreignCoordinator, sessionId: 's', contextOutput: output, resultReadScopeFor: resolveScope })
    try {
      let published = false
      await expect(coordinator.withProcessReadObservation!('s', { documentKeys: [] }, async () => {
        expect(await foreignReader.readResultPage!('s', { ref: member.ref, viaCatalog: catalog.ref })).toMatchObject({ kind: 'unavailable' }); return 'cached'
      }, async result => { published = true; return result })).rejects.toThrow()
      expect(published).toBe(false)
    } finally { await foreignReader.close(); await foreignCoordinator.close() }
    const leave = Promise.withResolvers<void>()
    let escaped: Promise<unknown> | undefined
    await coordinator.withProcessReadObservation!('s', { documentKeys: [] }, async () => {
      escaped = leave.promise.then(() => reader.readResultPage!('s', { ref: member.ref, viaCatalog: catalog.ref })); return 'original'
    }, async result => result)
    leave.resolve(); expect(await escaped).toMatchObject({ kind: 'unavailable' })
    expect(visibleRefsFor).not.toHaveBeenCalled()
  } finally { trace.active = false; trace.afterRead = undefined; await reader.close(); await native.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
