import { expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import type { BackgroundJobView, NativeExecService, NativeJobIdentity, JobOutputObservation } from '@i-harness/exec'
import { withExecCallerScope } from '@i-harness/exec'
import { contextWorkspaceLocation, createContextOutputService } from '@i-harness/context-output'
import type { ManagedArtifactRef, ResultDependencyCatalog } from '@i-harness/core-session'
import { currentToolResultProducer, toolResultDependencies, type ToolExec } from '@i-harness/core-tools'
import { createSessionAssembly } from '../src/assembly.ts'
import { controlledModel } from './controlled-model.ts'
import { acquireAssemblyResultStore } from '../src/lifecycle/result-store.ts'

const worker = [
  "import { existsSync } from 'node:fs'",
  "process.stdout.write(Buffer.concat([Buffer.alloc(150000, 120), Buffer.from('A'), Buffer.from([0]), Buffer.from('\u{1F600}'), Buffer.from('END')]))",
  "while (!existsSync(process.argv[2])) await new Promise(done => setTimeout(done, 10))",
  "process.stderr.write(Buffer.from([0xff, 0x00, 0x7f]))",
].join('\n')

it('summarizes the genuine original 150009-byte background capture through a registered J2 observer and authentic catalog', async () => {
  const base = resolve(import.meta.dirname, '../../../build/r4a-background-exec-tests')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(resolve(base, 'background-')), settings = resolve(root, 'settings.json')
  await writeFile(settings, JSON.stringify({ contextSubsystems: { contextOutput: { enabled: false, maxDiskBytes: 8388608 } } }))
  const workerPath = resolve(root, 'worker.mjs'), releasePath = resolve(root, 'release-worker')
  await writeFile(workerPath, worker)
  const command = '& "' + process.execPath + '" "' + workerPath + '" "' + releasePath + '"'
  const coordinator = createSessionCoordinator(createJsonlBackend(resolve(root, 'sessions')), { lock: { enabled: true } }), { id } = await coordinator.create()
  let sends = 0, startupAt = 0, revoked = false, jobId: string | undefined
  const assembly = await createSessionAssembly({ workspace: root, coordinator, sessionId: id, contextOutputSettingsPath: settings, shellRetention: { maxBytes: 4 },
    model: controlledModel(async function* () {
      const call = ++sends
      if (call === 1) {
        startupAt = Date.now()
        yield { type: 'tool_call', call: { id: 'actual-background', name: 'pwsh', args: { command, background: true } } }
      } else if (call === 3) {
        yield { type: 'tool_call', call: { id: 'read-background-pending', name: 'j2_observe', args: { job_id: jobId } } }
      } else if (call === 5) {
        yield { type: 'tool_call', call: { id: 'read-background-1', name: 'j2_observe', args: { job_id: jobId } } }
      } else if (call === 7) {
        yield { type: 'tool_call', call: { id: 'read-background-2', name: 'j2_observe', args: { job_id: jobId } } }
      } else yield { type: 'text/chunk', text: 'done' }
      yield { type: 'end' }
    }) })
  const registeredObservers: { producer: ToolExec; synchronousDependencies: number }[] = []
  assembly.tools.register({ name: 'j2_observe', description: 'J2 port control', inputSchema: { type: 'object', properties: { job_id: { type: 'string' } } }, isReadOnly: true,
    execute: args => {
      const producer = currentToolResultProducer()
      if (!producer) throw new Error('Expected genuine registered observer')
      const observation = assembly.ctx.services.get<NativeExecService>('exec/service')!.observeJobOutput((args as { job_id: string }).job_id)
      // Measure synchronously before the first await/finalizer, rather than
      // inferring registration from an eventually available catalog.
      registeredObservers.push({ producer, synchronousDependencies: toolResultDependencies(producer).length })
      return observation
    } })
  let cold: ReturnType<typeof createContextOutputService> | undefined, startupProducer: ToolExec | undefined
  let recipientAssembly: Awaited<ReturnType<typeof createSessionAssembly>> | undefined
  let originalStore: Awaited<ReturnType<typeof acquireAssemblyResultStore>> | undefined
  let primaryFailure = false
  assembly.ctx.on('tools/post-execute', input => { if ((input as { name: string }).name === 'pwsh') startupProducer = currentToolResultProducer() })
  try {
    await assembly.agent.run('start one real background command')
    // Startup gate: the tool receipt carried the job id without waiting for EOF.
    expect(Date.now() - startupAt).toBeLessThan(10_000)
    const event = assembly.session.events.find(event => event.type === 'tool/result' && event.callId === 'actual-background')
    if (event?.type !== 'tool/result') throw new Error('Expected the real background tool result')
    const receipt = event.envelope?.retention.kind === 'inline' ? event.envelope.retention.value as { job_id?: string; native_job?: NativeJobIdentity } : undefined
    if (!receipt?.job_id) throw new Error('Expected a background job id receipt: ' + JSON.stringify(event.envelope?.retention))
    jobId = receipt.job_id
    // The startup receipt is not an observer of the unfinished capture.
    expect(event.envelope?.dependencies).toBeUndefined()
    expect(startupProducer).toBeDefined()
    expect(toolResultDependencies(startupProducer!)).toHaveLength(0)
    const exec = assembly.ctx.services.get<NativeExecService>('exec/service')!
    expect((await exec.observeJobOutput(jobId)).source).toEqual({ kind: 'pending' })
    const startup = exec.getOutput(jobId)
    expect(receipt.native_job).toEqual(startup.nativeJob)
    expect(receipt.native_job?.instanceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(startup.status).toBe('running')
    expect(startup.retained).toBeUndefined()

    originalStore = await acquireAssemblyResultStore({ workspace: root, coordinator, sessionId: id, contextOutputSettingsPath: settings })
    const pendingReads = vi.spyOn(originalStore.service!, 'readExecResult')
    const pendingGrants = vi.spyOn(originalStore.service!, 'grant')
    const nativeCancellation = vi.spyOn(exec, 'killJob')
    try {
      // The original worker is still held at its release-file gate. This
      // complete registered turn must finalize before releasing native EOF.
      await assembly.agent.run('observe pending metadata while the original producer remains open')
      const pendingEvent = assembly.session.events.find(event => event.type === 'tool/result' && event.callId === 'read-background-pending')
      if (pendingEvent?.type !== 'tool/result' || pendingEvent.envelope?.retention.kind !== 'inline') throw new Error('Expected successfully finalized registered pending metadata')
      expect(pendingEvent.envelope.execution).toEqual({ outcome: 'succeeded', dispatch: 'dispatched' })
      expect(pendingEvent.envelope.retention.value).toMatchObject({ nativeJob: receipt.native_job, view: { status: 'running' }, source: { kind: 'pending' } })
      expect((pendingEvent.envelope.retention.value as unknown as JobOutputObservation).source).toEqual({ kind: 'pending' })
      expect(pendingEvent.envelope.dependencies).toBeUndefined()
      expect(registeredObservers).toHaveLength(1)
      expect(registeredObservers[0]!.synchronousDependencies).toBe(0)
      expect(toolResultDependencies(registeredObservers[0]!.producer)).toHaveLength(0)
      expect(pendingReads).not.toHaveBeenCalled()
      expect(pendingGrants).not.toHaveBeenCalled()
      expect(nativeCancellation).not.toHaveBeenCalled()
      expect(exec.getJobView(jobId)).toMatchObject({ nativeJob: receipt.native_job, status: 'running' })
    } finally { pendingReads.mockRestore(); pendingGrants.mockRestore(); nativeCancellation.mockRestore() }

    // No further getOutput/listJobs call asks for output before completion;
    // the subscriber verifies automatic original capture settlement.
    const completed = new Promise<BackgroundJobView>((resolveView, rejectView) => {
      const timer = setTimeout(() => rejectView(new Error('background job did not settle')), 60_000)
      const stop = exec.subscribeJob(jobId!, view => {
        if (view.status === 'running') return
        clearTimeout(timer); stop(); resolveView(view)
      })
    })
    await writeFile(releasePath, '')
    const terminal = await completed
    const observingList = vi.spyOn(exec, 'listJobs').mockImplementation(() => { throw new Error('metadata projection must be passive') })
    try {
      expect(terminal.truncated?.stdout).toBe(true)
      expect(assembly.backgroundJobs!().find(job => job.id === jobId)).toMatchObject({ nativeJob: receipt.native_job, outputTruncated: true })
    }
    finally { observingList.mockRestore() }
    expect(toolResultDependencies(startupProducer!), 'Passive completion must not mutate the finalized startup producer').toHaveLength(0)
    expect(terminal.status, JSON.stringify({ stdout: terminal.stdout, stderr: terminal.stderr })).toBe('completed')
    expect(terminal.exitCode).toBe(0)
    if (!terminal.retained) throw new Error('Expected automatic artifact settlement: ' + JSON.stringify({ retained: terminal.retained, failure: terminal.retentionFailure }))
    const dependency = terminal.retained
    if (dependency.retention.kind !== 'artifact') throw new Error('Expected automatic artifact settlement: ' + JSON.stringify({ retained: dependency, failure: terminal.retentionFailure }))
    expect(terminal.retentionFailure).toBeUndefined()

    const location = await contextWorkspaceLocation(root, coordinator.storageRoot!)
    cold = createContextOutputService({ root: location.serviceRoot, workspaceId: location.workspaceKey, authorizeResult: async (access, metadata) => !revoked && (access.sessionId === metadata.owner.sessionId || !!metadata.visibleVia) && !(await coordinator.profile(access.sessionId)).meta.archived })
    async function bytesOf(ref: ManagedArtifactRef) {
      const pieces: Buffer[] = []; let offset = 0
      for (;;) {
        const page = await cold!.readResult({ sessionId: id }, { ref, offset })
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(32768)
        pieces.push(page.data.kind === 'text' ? Buffer.from(page.data.text) : Buffer.from(page.data.base64, 'base64'))
        if (page.eof) break
        offset = page.nextOffset!
      }
      return Buffer.concat(pieces)
    }
    const body = await bytesOf(dependency.retention.ref)
    expect(body.subarray(0, 9).toString()).toBe('IHEXEC01\n')
    expect(createHash('sha256').update(body).digest('hex')).toBe(dependency.retention.ref.contentDigest)
    // Independent expected bytes: exact channel/frame/offset order and values.
    const expected = [
      { channel: 'stdout', bytes: Buffer.concat([Buffer.alloc(150000, 120), Buffer.from('A'), Buffer.from([0]), Buffer.from('😀'), Buffer.from('END')]) },
      { channel: 'stderr', bytes: Buffer.from([0xff, 0x00, 0x7f]) },
    ]
    const records = body.subarray(9).toString().split('\n').filter(Boolean).map(line => JSON.parse(line))
    const decoded = { stdout: [] as Buffer[], stderr: [] as Buffer[] }
    for (const part of records) decoded[part.channel as 'stdout' | 'stderr'].push(Buffer.from(part.data, 'base64'))
    expect(Buffer.concat(decoded.stdout).length, JSON.stringify({ ref: dependency.retention.ref, diagnostics: terminal.outputDiagnostics,
      records: records.map(part => ({ channel: part.channel, frame: part.frame, offset: part.offset, end: part.end, bytes: Buffer.from(part.data, 'base64').length })) })).toBe(150009)
    expect(Buffer.concat(decoded.stdout)).toEqual(expected[0]!.bytes)
    expect(Buffer.concat(decoded.stderr)).toEqual(expected[1]!.bytes)
    expect(expected[0]!.bytes.length).toBe(150009)
    const originalRead = originalStore.service!.readExecResult.bind(originalStore.service!)
    let releaseScan!: () => void, enteredScan!: () => void, scanSignal: AbortSignal | undefined
    const scanGate = new Promise<void>(done => { releaseScan = done }), scanEntered = new Promise<void>(done => { enteredScan = done })
    const scanSignals = new Set<AbortSignal>()
    const reads = vi.spyOn(originalStore.service!, 'readExecResult').mockImplementation(async (access, query) => {
      if (access.signal) {
        scanSignals.add(access.signal)
        if (!scanSignal) { scanSignal = access.signal; enteredScan(); await scanGate }
      }
      return originalRead(access, query)
    })
    let firstSummary: JobOutputObservation
    try {
      const controller = new AbortController()
      const aborted = exec.observeJobOutput(jobId, { signal: controller.signal })
      const survivor = exec.observeJobOutput(jobId)
      await scanEntered
      await new Promise<void>(done => setImmediate(done))
      controller.abort(new Error('detach one genuine reader'))
      await expect(aborted).rejects.toThrow('detach one genuine reader')
      expect(scanSignal!.aborted).toBe(false)
      releaseScan()
      firstSummary = await survivor
      expect(scanSignals.size).toBe(1)
    } finally { releaseScan(); reads.mockRestore() }
    expect(firstSummary.source).toMatchObject({ kind: 'retained-summary', dependency, summary: {
      stdout: { bytes: 150009, sha256: createHash('sha256').update(expected[0]!.bytes).digest('hex') },
      stderr: { bytes: 3, sha256: createHash('sha256').update(expected[1]!.bytes).digest('hex') },
      totalRawBytes: 150012, completeness: 'complete',
    } })
    expect(Buffer.byteLength(firstSummary.view.stdout)).toBeLessThan(64000)
    const deniedRead = vi.spyOn(originalStore.service!, 'readExecResult').mockRejectedValue(new Error('isolated original reader refusal'))
    try {
      expect((await exec.observeJobOutput(jobId)).source).toEqual({ kind: 'unavailable', reason: 'read-unavailable' })
      expect(exec.getJobView(jobId)).toMatchObject({ status: 'completed', retained: dependency })
    } finally { deniedRead.mockRestore() }
    expect((await exec.observeJobOutput(jobId)).source).toEqual(firstSummary.source)
    // Any later query returns the same immutable ref/revision.
    const later = exec.getOutput(jobId)
    expect(later.retained).toEqual(dependency)
    expect(later.retentionFailure).toBeUndefined()

    // A genuine second Agent turn reads the completed job through the
    // registered J2 fixture tool. Its finalizer must bind the original source;
    // the shipping job_output consumer remains a later cutover.
    async function readCatalog(callId: string): Promise<ResultDependencyCatalog> {
      await assembly.agent.run('read the completed background output')
      const result = assembly.session.events.find(event => event.type === 'tool/result' && event.callId === callId)
      if (result?.type !== 'tool/result' || !result.envelope) throw new Error('Expected the registered J2 observer result for ' + callId)
      const value = result.envelope.retention.kind === 'inline' ? result.envelope.retention.value as unknown as JobOutputObservation : undefined
      expect(value?.source).toMatchObject({ kind: 'retained-summary', summary: { stdout: { bytes: 150009 }, totalRawBytes: 150012 } })
      expect(value?.nativeJob).toEqual(startup.nativeJob)
      expect(registeredObservers.at(-1)!.synchronousDependencies).toBe(1)
      expect(toolResultDependencies(registeredObservers[0]!.producer)).toHaveLength(0)
      const dependencies = result.envelope.dependencies
      expect(dependencies, 'Registered J2 observer must bind this actual native source').toMatchObject({ kind: 'artifact-set', count: 1 })
      const catalog = JSON.parse((await bytesOf((dependencies as { ref: ManagedArtifactRef }).ref)).toString()) as ResultDependencyCatalog
      expect(catalog).toMatchObject({ version: 1, kind: 'result-dependencies' })
      expect(catalog.entries).toHaveLength(1)
      return catalog
    }
    const first = await readCatalog('read-background-1')
    expect(first.entries[0]!.sourceId).toBe(dependency.sourceId)
    expect(first.entries[0]!.retention).toEqual(dependency.retention)
    // The catalog points at the same automatically committed frames, and the
    // cold page content is the same complete body.
    const viaCatalog = await bytesOf((first.entries[0]!.retention as { ref: ManagedArtifactRef }).ref)
    expect(createHash('sha256').update(viaCatalog).digest('hex')).toBe(dependency.retention.ref.contentDigest)
    expect(viaCatalog.equals(body)).toBe(true)

    const second = await readCatalog('read-background-2')
    expect(second.entries[0]!.sourceId).toBe(first.entries[0]!.sourceId)
    expect(second.entries[0]!.retention).toEqual(first.entries[0]!.retention)

    // A separate genuine recipient call gets its own committed catalog. The
    // fixture invokes the original owner capability explicitly; it grants no
    // native execution authority to this otherwise unrelated recipient.
    const recipient = await coordinator.create()
    let recipientSends = 0
    recipientAssembly = await createSessionAssembly({ workspace: root, coordinator, sessionId: recipient.id, contextOutputSettingsPath: settings,
      model: controlledModel(async function* () {
        if (++recipientSends === 1) yield { type: 'tool_call', call: { id: 'recipient-observer', name: 'j2_recipient', args: {} } }
        else yield { type: 'text/chunk', text: 'done' }
        yield { type: 'end' }
      }) })
    recipientAssembly.tools.register({ name: 'j2_recipient', description: 'Trusted original owner observation control', inputSchema: { type: 'object' }, isReadOnly: true,
      execute: () => withExecCallerScope({ sessionId: id }, () => exec.observeJobOutput(jobId!)) })
    await recipientAssembly.agent.run('observe the original capture through a separate authentic recipient')
    const recipientEvent = recipientAssembly.session.events.find(event => event.type === 'tool/result' && event.callId === 'recipient-observer')
    if (recipientEvent?.type !== 'tool/result' || recipientEvent.envelope?.dependencies?.kind !== 'artifact-set') throw new Error('Expected genuine recipient catalog')
    const recipientCatalogRef = recipientEvent.envelope.dependencies.ref
    const recipientPage = await cold.readResult({ sessionId: recipient.id }, { ref: recipientCatalogRef })
    if (recipientPage.data.kind !== 'text' || !recipientPage.eof) throw new Error('Expected bounded recipient catalog JSON')
    expect(JSON.parse(recipientPage.data.text).entries).toEqual([dependency])
    await expect(cold.readExecResult({ sessionId: recipient.id }, { ref: dependency.retention.ref })).rejects.toThrow()
    const recipientFrames = await cold.readExecResult({ sessionId: recipient.id }, { ref: dependency.retention.ref, viaCatalog: recipientCatalogRef })
    expect(recipientFrames.frames.length).toBeGreaterThan(0)
    await expect(cold.readExecResult({ sessionId: 'foreign' }, { ref: dependency.retention.ref, viaCatalog: recipientCatalogRef })).rejects.toThrow()

    // A revoked reader cannot read the body, but the descriptor still exists
    // and the original artifact is untouched.
    revoked = true
    await expect(cold.readResult({ sessionId: id }, { ref: dependency.retention.ref })).rejects.toThrow()
    expect(exec.getOutput(jobId).retained).toMatchObject({ retention: { kind: 'artifact', ref: { id: dependency.retention.ref.id } } })
    revoked = false
    expect((await bytesOf(dependency.retention.ref)).equals(body)).toBe(true)
  } catch (cause) {
    primaryFailure = true
    throw cause
  } finally {
    await writeFile(releasePath, '')
    await cold?.close()
    await recipientAssembly?.dispose()
    await originalStore?.release()
    try { await assembly.dispose() }
    catch (cause) {
      if (!primaryFailure) throw cause
      console.error('Secondary cleanup failure after the preserved primary assertion/dispatch failure:', cause)
    }
    await coordinator.close()
    await rm(root, { recursive: true, force: true })
  }
})
