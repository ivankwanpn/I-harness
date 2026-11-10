import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createJsonlTaskTransitionCoordinator } from '@i-harness/session-persistence-jsonl/internal/task-document-factory'
import { taskDocumentStorageContract } from '@i-harness/subagent/internal/task-storage-contract'
import { contextWorkspaceLocation } from '@i-harness/context-output'
import { acquireAssemblyResultStore, acquireResultReadStore, type ResultReadScope } from '../src/lifecycle/result-store.ts'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('ih-result-scope-current-')) throw Error('Unsafe fixture cleanup')
    await rm(root, { recursive: true, force: true })
  }
})

it.each(['scoped', 'unscoped'] as const)('keeps same-authority %s cold reads but refuses changed, unavailable and foreign scopes', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'ih-result-scope-current-'))
  roots.push(root)
  const settings = join(root, 'settings.json')
  await writeFile(settings, '{}')
  const open = () => createJsonlTaskTransitionCoordinator(join(root, 'sessions'), { lock: { enabled: true } }, taskDocumentStorageContract)
  const original = open()
  await original.create({ sessionId: 'owner' })
  await original.create({ sessionId: 'foreign' })
  const options = { workspace: root, sessionId: 'owner', contextOutputSettingsPath: settings }
  const project = mode === 'scoped' ? { id: 'p', roots: [root] } : undefined
  const producer = await acquireAssemblyResultStore({ ...options, coordinator: original, ...(project ? { projectContext: () => project } : {}) })
  let ref: import('@i-harness/core-session').ManagedArtifactRef
  let capturedSource: Awaited<ReturnType<NonNullable<typeof producer.sourceFor>>>
  try {
    capturedSource = await producer.sourceFor!('owner')
    const scope = producer.service!.registerResultScope({ operationId: 'saved-result', sessionId: 'owner', callId: 'capture', source: capturedSource }, () => true)
    const sink = await producer.service!.beginResult(scope, 'text-utf8-v1')
    await sink.write(Buffer.from('Original retained bytes'))
    const saved = await sink.finish('complete')
    if (saved.kind !== 'committed') throw Error('Actual artifact capture refused')
    ref = saved.ref
  } finally { await producer.release(); await original.close() }

  const cold = open()
  const location = await contextWorkspaceLocation(root, cold.storageRoot!)
  const artifact = join(location.serviceRoot, 'context-output', createHash('sha256').update(location.workspaceKey).digest('hex'), 'managed-v1', ref.id)
  const files = ['body', 'index', 'manifest.json'].map(name => join(artifact, name))
  const savedBytes = await Promise.all(files.map(path => readFile(path)))
  let current: ResultReadScope = { revision: 'current', ...(project ? { projectId: project.id, scope: project } : {}) }
  let available = true, unresolved = false
  const reader = await acquireResultReadStore({ ...options, coordinator: cold, readCallerAvailable: () => available }, () => {
    if (unresolved) throw Error('Current scope unavailable')
    return current
  })
  const read = (sessionId = 'owner') => reader.withProcessReadContext!(() => reader.service!.readResult!({ sessionId }, { ref }))
  try {
    expect(await reader.sourceFor!('owner')).toEqual(capturedSource)
    expect(await read()).toMatchObject({ ref, eof: true, data: { text: 'Original retained bytes' } })
    current = { revision: 'changed', projectId: 'revoked', scope: { id: 'revoked', roots: [root] } }
    await expect(read()).rejects.toThrow('unavailable or unauthorized')
    current = { revision: 'same-authority-new-revision', ...(project ? { projectId: project.id, scope: project } : {}) }
    expect(await read()).toMatchObject({ ref, data: { text: 'Original retained bytes' } })
    unresolved = true
    await expect(read()).rejects.toThrow('unavailable or unauthorized')
    unresolved = false
    await expect(read('foreign')).rejects.toThrow('unavailable or unauthorized')
    available = false
    await expect(read()).rejects.toThrow('PROCESS_READ_UNAVAILABLE')
    available = true
    expect(await read()).toMatchObject({ ref, data: { text: 'Original retained bytes' } })
    expect(await Promise.all(files.map(path => readFile(path)))).toEqual(savedBytes)
  } finally { await reader.release(); await cold.close() }
})
