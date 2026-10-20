import { expect } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import type { ContextOutputService } from '@i-harness/context-output'
import type { ExecService } from '@i-harness/exec'
import type { ManagedArtifactRef } from '@i-harness/core-session'

export const evidence = resolve(import.meta.dirname, '../../../.tmp/context-r4a-native-dependencies-20261021-implementation')
await mkdir(evidence, { recursive: true })
await mkdir(resolve(evidence, 'config'), { recursive: true })
process.env.IH_CONFIG_DIR = resolve(evidence, 'config')
export const { createSessionCoordinator } = await import('@i-harness/session-persistence')
export const { createJsonlBackend } = await import('@i-harness/session-persistence-jsonl')
export const { contextWorkspaceLocation } = await import('@i-harness/context-output')
export const { createSessionAssembly } = await import('../src/assembly.ts')
export const { createSessionService } = await import('../src/service.ts')
export const { acquireAssemblyResultStore, acquireResultReadStore } = await import('../src/lifecycle/result-store.ts')
export const { controlledModel } = await import('./controlled-model.ts')
export const { currentToolResultProducer, toolResultDependencies } = await import('@i-harness/core-tools')
export const { sessionArtifactManifest } = await import('../../desktop-gateway/src/session-artifacts.ts')
export const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

export async function rawBytes(service: ContextOutputService, id: string, ref: ManagedArtifactRef) {
  const parts: Buffer[] = []; let offset = 0
  for (;;) {
    const page = await service.readResult({ sessionId: id }, { ref, offset, maxBytes: 4096 })
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(4096)
    parts.push(page.data.kind === 'text' ? Buffer.from(page.data.text) : Buffer.from(page.data.base64, 'base64'))
    if (page.eof) break
    expect(page.nextOffset).toBeGreaterThan(offset); offset = page.nextOffset!
  }
  const body = Buffer.concat(parts)
  expect(body.length).toBe(ref.encodedBytes); expect(sha(body)).toBe(ref.contentDigest)
  return body
}

export async function fixture(label: string) {
  const root = await mkdtemp(resolve(evidence, label + '-')), settings = resolve(root, 'settings.json'), sessions = resolve(root, 'sessions')
  await writeFile(settings, JSON.stringify({ contextSubsystems: { contextOutput: { enabled: false, maxDiskBytes: 16777216 } } }))
  const coordinator = createSessionCoordinator(createJsonlBackend(sessions), { lock: { enabled: true } }), { id } = await coordinator.create()
  const lease = await acquireAssemblyResultStore({ workspace: root, coordinator, sessionId: id, contextOutputSettingsPath: settings })
  if (!lease.service) throw new Error('Original automatic store unavailable')
  const location = await contextWorkspaceLocation(root, coordinator.storageRoot!)
  const managed = resolve(location.serviceRoot, 'context-output', sha(location.workspaceKey), 'managed-v1')
  const ownedRoot = resolve(location.serviceRoot, 'context-output', sha(location.workspaceKey))
  const service = lease.service
  let assembly: Awaited<ReturnType<typeof createSessionAssembly>> | undefined
  let exec: ExecService | undefined
  return { root, settings, sessions, coordinator, id, lease, service, location, managed, ownedRoot,
    get assembly() { return assembly! }, get exec() { return exec! },
    async mount(execute: () => Promise<unknown>) {
      let sends = 0
      assembly = await createSessionAssembly({ workspace: root, coordinator, sessionId: id, contextOutputSettingsPath: settings,
        sandbox: 'danger-full-access', modelPolicy: 'test-mock', approveAll: true,
        model: controlledModel(async function* () {
          if (++sends === 1) yield { type: 'tool_call', call: { id: 'composition', name: 'native_pair', args: {} } }
          else yield { type: 'text/chunk', text: 'done' }
          yield { type: 'end' }
        }), additionalTools: [{ name: 'native_pair', description: 'two actual native sources', inputSchema: {}, async execute() { return execute() } }] })
      exec = assembly.ctx.services.get<ExecService>('exec/service')!
    },
    async inventory() {
      const names = await readdir(managed)
      return Promise.all(names.map(async name => ({ name, operation: JSON.parse(await readFile(resolve(managed, name, 'operation.json'), 'utf8')), pins: await readdir(resolve(managed, name, 'pins')).catch(() => []) })))
    },
    async retire() { await assembly?.dispose(); assembly = undefined; await lease.release(); await coordinator.close() },
    async close() {
      if (exec) for (const job of exec.listJobs()) if (job.status === 'running') await exec.killJob(job.id)
      await assembly?.dispose(); assembly = undefined; await lease.release(); await coordinator.close()
      await writeFile(resolve(root, 'cleanup.json'), JSON.stringify({ ownedJobsClosed: true }))
    },
  }
}
