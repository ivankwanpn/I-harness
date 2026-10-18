import { expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import type { ExecService } from '@i-harness/exec'
import { contextWorkspaceLocation, createContextOutputService } from '@i-harness/context-output'
import type { ManagedArtifactRef } from '@i-harness/core-session'
import { createSessionAssembly } from '../src/assembly.ts'
import { controlledModel } from './controlled-model.ts'

it('binds actual native frames beside complete returned execution metadata through the real assembly', async () => {
  const base = resolve(import.meta.dirname, '../../../build/r4a-exec-flow-tests')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(resolve(base, 'native-')), settings = resolve(root, 'settings.json')
  await writeFile(settings, JSON.stringify({ contextSubsystems: { contextOutput: { enabled: false, maxDiskBytes: 8388608 } } }))
  const coordinator = createSessionCoordinator(createJsonlBackend(resolve(root, 'sessions')), { lock: { enabled: true } }), { id } = await coordinator.create()
  let sends = 0, bodies = 0
  let assembly: Awaited<ReturnType<typeof createSessionAssembly>>
  assembly = await createSessionAssembly({ workspace: root, coordinator, sessionId: id, contextOutputSettingsPath: settings,
    model: controlledModel(async function* () {
      if (++sends === 1) yield { type: 'tool_call', call: { id: 'actual-native', name: 'native_source', args: {} } }
      else yield { type: 'text/chunk', text: 'complete' }
      yield { type: 'end' }
    }), additionalTools: [{ name: 'native_source', description: 'controlled local Node source', inputSchema: {}, isReadOnly: true, async execute() {
      bodies++
      return assembly.ctx.services.get<ExecService>('exec/service')!.run({ argv: [process.execPath, '-e', "process.stdout.write(Buffer.alloc(1048576,120));process.stderr.write('marker');process.exitCode=5"] })
    } }] })
  try {
    await assembly.agent.run('retain exact native frames and metadata')
    const event = assembly.session.events.find(event => event.type === 'tool/result')
    expect(event?.type === 'tool/result' ? event.envelope?.dependencies?.kind : undefined).toBe('artifact-set')
    if (event?.type !== 'tool/result' || event.envelope?.dependencies?.kind !== 'artifact-set') throw new Error('Expected registered frame dependency catalog')
    expect(event.envelope.dependencies.count).toBe(1)
    expect(event.envelope.dependencies.ref.codec).toBe('json-utf8-v1')
    expect(event.envelope.dependencies.ref.completeness).toBe('complete')
    const location = await contextWorkspaceLocation(root, coordinator.storageRoot!)
    const cold = createContextOutputService({ root: location.serviceRoot, workspaceId: location.workspaceKey, authorizeResult: async (access, metadata) => access.sessionId === metadata.owner.sessionId && !(await coordinator.profile(access.sessionId)).meta.archived })
    async function bytesOf(ref: ManagedArtifactRef) {
      const pieces: Buffer[] = []; let offset = 0
      for (;;) {
        const page = await cold.readResult({ sessionId: id }, { ref, offset })
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(32768)
        pieces.push(page.data.kind === 'text' ? Buffer.from(page.data.text) : Buffer.from(page.data.base64, 'base64'))
        if (page.eof) break
        offset = page.nextOffset!
      }
      return Buffer.concat(pieces)
    }
    try {
      const primary = event.envelope.retention
      const returned = primary.kind === 'inline' ? primary.value : primary.kind === 'artifact' ? JSON.parse((await bytesOf(primary.ref)).toString()) : undefined
      expect(returned).toMatchObject({ exitCode: 5, timedOut: false, stderr: 'marker' })
      expect(Buffer.byteLength(returned.stdout)).toBeLessThanOrEqual(64000)
      const catalog = JSON.parse((await bytesOf(event.envelope.dependencies.ref)).toString())
      expect(catalog).toMatchObject({ version: 1, kind: 'result-dependencies', entries: [{ kind: 'exec-frames', retention: { kind: 'artifact', ref: { codec: 'exec-frames-v1', completeness: 'complete' } } }] })
      const ref = catalog.entries[0].retention.ref, body = await bytesOf(ref)
      expect(body.subarray(0, 9).toString()).toBe('IHEXEC01\n')
      expect(createHash('sha256').update(body).digest('hex')).toBe(ref.contentDigest)
      const stdout = createHash('sha256'), stderr = createHash('sha256'); let stdoutBytes = 0, stderrBytes = 0
      for (const line of body.subarray(9).toString().split('\n').filter(Boolean)) {
        const part = JSON.parse(line), bytes = Buffer.from(part.data, 'base64')
        expect(Object.keys(part)).toEqual(['channel', 'frame', 'offset', 'end', 'data'])
        expect(bytes.length).toBeLessThanOrEqual(32768)
        if (part.channel === 'stdout') { stdout.update(bytes); stdoutBytes += bytes.length }
        else { expect(part.channel).toBe('stderr'); stderr.update(bytes); stderrBytes += bytes.length }
      }
      expect(stdoutBytes).toBe(1_048_576); expect(stderrBytes).toBe(6)
      expect(stdout.digest('hex')).toBe(createHash('sha256').update(Buffer.alloc(1_048_576, 120)).digest('hex'))
      expect(stderr.digest('hex')).toBe(createHash('sha256').update('marker').digest('hex'))
    } finally { await cold.close() }
    expect(bodies).toBe(1)
  } finally { await assembly.dispose(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
