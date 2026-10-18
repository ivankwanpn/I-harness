import { expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import type { BackgroundJobView, ExecService } from '@i-harness/exec'
import { contextWorkspaceLocation, createContextOutputService } from '@i-harness/context-output'
import type { ManagedArtifactRef } from '@i-harness/core-session'
import { createSessionAssembly } from '../src/assembly.ts'
import { controlledModel } from './controlled-model.ts'

const worker = [
  "process.stdout.write(Buffer.concat([Buffer.from('A'), Buffer.from([0]), Buffer.from('\u{1F600}')]))",
  "setTimeout(() => { process.stderr.write(Buffer.from([0xff, 0x00, 0x7f])) }, 400)",
].join('\n')

it('settles one background frame dependency automatically and returns the same revision on any later query', async () => {
  const base = resolve(import.meta.dirname, '../../../build/r4a-background-exec-tests')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(resolve(base, 'background-')), settings = resolve(root, 'settings.json')
  await writeFile(settings, JSON.stringify({ contextSubsystems: { contextOutput: { enabled: false, maxDiskBytes: 8388608 } } }))
  const workerPath = resolve(root, 'worker.mjs')
  await writeFile(workerPath, worker)
  const command = `& "${process.execPath}" "${workerPath}"`
  const coordinator = createSessionCoordinator(createJsonlBackend(resolve(root, 'sessions')), { lock: { enabled: true } }), { id } = await coordinator.create()
  let sends = 0, startupAt = 0
  const assembly = await createSessionAssembly({ workspace: root, coordinator, sessionId: id, contextOutputSettingsPath: settings,
    model: controlledModel(async function* () {
      if (++sends === 1) {
        startupAt = Date.now()
        yield { type: 'tool_call', call: { id: 'actual-background', name: 'pwsh', args: { command, background: true } } }
      } else yield { type: 'text/chunk', text: 'done' }
      yield { type: 'end' }
    }) })
  let cold: ReturnType<typeof createContextOutputService> | undefined
  try {
    await assembly.agent.run('start one real background command')
    // Startup gate: the tool receipt carried the job id without waiting for EOF.
    expect(Date.now() - startupAt).toBeLessThan(10_000)
    const event = assembly.session.events.find(event => event.type === 'tool/result' && event.callId === 'actual-background')
    if (event?.type !== 'tool/result') throw new Error('Expected the real background tool result')
    const receipt = event.envelope?.retention.kind === 'inline' ? event.envelope.retention.value as { job_id?: string } : undefined
    if (!receipt?.job_id) throw new Error(`Expected a background job id receipt: ${JSON.stringify(event.envelope?.retention)}`)
    const jobId = receipt.job_id
    const exec = assembly.ctx.services.get<ExecService>('exec/service')!
    const startup = exec.getOutput(jobId)
    expect(startup.status).toBe('running')
    expect(startup.retained).toBeUndefined()

    // A subscriber is the only observer; no getOutput/listJobs call asks for
    // the output before completion, so settlement must be automatic.
    const terminal = await new Promise<BackgroundJobView>((resolveView, rejectView) => {
      const timer = setTimeout(() => rejectView(new Error('background job did not settle')), 60_000)
      const stop = exec.subscribeJob(jobId, view => {
        if (view.status === 'running') return
        clearTimeout(timer); stop(); resolveView(view)
      })
    })
    expect(terminal.status, JSON.stringify({ stdout: terminal.stdout, stderr: terminal.stderr })).toBe('completed')
    expect(terminal.exitCode).toBe(0)
    if (!terminal.retained) throw new Error(`Expected automatic artifact settlement: ${JSON.stringify({ retained: terminal.retained, failure: terminal.retentionFailure })}`)
    const dependency = terminal.retained
    if (dependency.retention.kind !== 'artifact') throw new Error(`Expected automatic artifact settlement: ${JSON.stringify({ retained: dependency, failure: terminal.retentionFailure })}`)
    expect(terminal.retentionFailure).toBeUndefined()

    const location = await contextWorkspaceLocation(root, coordinator.storageRoot!)
    cold = createContextOutputService({ root: location.serviceRoot, workspaceId: location.workspaceKey, authorizeResult: async (access, metadata) => access.sessionId === metadata.owner.sessionId && !(await coordinator.profile(access.sessionId)).meta.archived })
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
      { channel: 'stdout', bytes: Buffer.concat([Buffer.from('A'), Buffer.from([0]), Buffer.from('😀')]) },
      { channel: 'stderr', bytes: Buffer.from([0xff, 0x00, 0x7f]) },
    ]
    const records = body.subarray(9).toString().split('\n').filter(Boolean).map(line => JSON.parse(line))
    const decoded: Buffer[] = []
    for (const [index, part] of records.entries()) {
      expect(Object.keys(part)).toEqual(['channel', 'frame', 'offset', 'end', 'data'])
      expect(part.channel).toBe(expected[index]!.channel)
      expect(part.frame).toBe(index)
      expect(part.offset).toBe(0)
      expect(part.end).toBe(true)
      decoded.push(Buffer.from(part.data, 'base64'))
    }
    expect(decoded).toEqual(expected.map(frame => frame.bytes))
    expect(createHash('sha256').update(Buffer.concat(decoded)).digest('hex'))
      .toBe(createHash('sha256').update(Buffer.concat(expected.map(frame => frame.bytes))).digest('hex'))

    // Any later query returns the same immutable ref/revision.
    const later = exec.getOutput(jobId)
    expect(later.retained).toEqual(dependency)
    expect(later.retentionFailure).toBeUndefined()
    expect(JSON.stringify(later.retained)).toBe(JSON.stringify(dependency))
  } finally {
    await cold?.close()
    await assembly.dispose()
    await coordinator.close()
    await rm(root, { recursive: true, force: true })
  }
})
