import { expect, it, vi } from 'vitest'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createContextOutputService } from '@i-harness/context-output'
import { createTaskRegistry, SHIPPING_REPORT_POLICY } from '@i-harness/subagent'
import { createTaskResultRetention } from '../src/lifecycle/task-result-retention.ts'

it('keeps the original child source snapshot across later scope changes instead of resolving it at settlement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'child-source-snapshot-'))
  let current = 'original', sourceReads = 0, ownerSource: string | undefined
  const service = createContextOutputService({ root, workspaceId: 'w', authorizeResult: async (_access, metadata) => { ownerSource = metadata.owner.source?.sourceId; return true } })
  try {
    const base = createTaskResultRetention(service, async () => { sourceReads++; return { sourceId: current, readonly: true } }, 'parent')
    const original = await (base as any).forSource?.() ?? base
    current = 'later'
    const tasks = createTaskRegistry({ reportPolicy: SHIPPING_REPORT_POLICY, results: original })
    const task = tasks.submit({ identity: { parentSessionId: 'parent' }, agentPath: 'root/a', description: 'a', prompt: 'go', agent: 'general', delivery: 'tool' })
    tasks.claim(task.id); tasks.terminalize({ taskId: task.id, outcome: 'completed', resultText: 'actual settled child' }); await tasks.retainResult(task.id)
    await tasks.readResult(task.id, {})
    expect(ownerSource).toBe('original')
    expect(sourceReads).toBe(1)
  } finally { await service.close(); await rm(root, { recursive: true, force: true }) }
})

it('pins a child body for both actual task and state/F1 documents before exposing its ready descriptor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'child-result-pins-'))
  const service = createContextOutputService({ root, workspaceId: 'w' })
  try {
    const tasks = createTaskRegistry({ reportPolicy: SHIPPING_REPORT_POLICY, results: createTaskResultRetention(service, undefined, 'parent') })
    const task = tasks.submit({ identity: { parentSessionId: 'parent' }, agentPath: 'root/a', description: 'a', prompt: 'go', agent: 'general', delivery: 'tool' })
    tasks.claim(task.id); tasks.terminalize({ taskId: task.id, outcome: 'completed', resultText: 'original child body' }); await tasks.retainResult(task.id)
    if (task.result?.kind !== 'retained' || task.result.envelope.retention.kind !== 'artifact') throw new Error('Expected committed body')
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    const pins = await readdir(join(root, 'context-output', hash('w'), 'managed-v1', task.result.envelope.retention.ref.id, 'pins'))
    expect(pins.sort()).toEqual([`${hash('parent')}.json`, `${hash('task-parent')}.json`].sort())
  } finally { await service.close(); await rm(root, { recursive: true, force: true }) }
})

it('keeps a child capture with its original passive settlement lifetime rather than an ended main-tool source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'child-passive-lifetime-'))
  const service = createContextOutputService({ root, workspaceId: 'w' })
  let held = true, reads = 0
  try {
    const store = createTaskResultRetention(service, undefined, 'parent')
    const original = await store.forSource!(undefined, () => held)
    const body = Object.defineProperty({}, 'resultText', { enumerable: true, get() { reads++; return 'actual original result' } })
    const capture = original.capture({ id: 'task', parentSessionId: 'parent', outcome: 'completed' }, body, 'held-passive-original')
    held = false
    expect((await capture.settle()).kind).toBe('recovery-required')
    held = true
    expect((await capture.settle()).kind).toBe('ready')
    expect(reads).toBe(1)
  } finally { await service.close(); await rm(root, { recursive: true, force: true }) }
})

it.each(['quota', 'unknown'] as const)('separates a second document pin %s from the already protected original body', async failure => {
  const root = await mkdtemp(join(tmpdir(), 'child-pin-disposition-'))
  const service = createContextOutputService({ root, workspaceId: 'w' })
  let reads = 0
  try {
    const grant = service.confirmResultOwner.bind(service)
    vi.spyOn(service, 'confirmResultOwner').mockImplementationOnce(async (...args) => {
      if (failure === 'quota') throw Object.assign(new Error('known quota refusal'), { code: 'ARTIFACT_QUOTA' })
      await grant(...args)
      throw new Error('original grant receipt unavailable')
    })
    const body = Object.defineProperty({}, 'resultText', { enumerable: true, get() { reads++; return 'original result' } })
    const capture = createTaskResultRetention(service, undefined, 'parent').capture({ id: 'task-1', parentSessionId: 'parent', outcome: 'completed' }, body, 'original-operation', { outcome: 'succeeded', dispatch: 'dispatched' })
    const first = await capture.settle()
    if (failure === 'quota') expect(first).toMatchObject({ kind: 'ready', envelope: { retention: { kind: 'unavailable', reason: 'quota' } } })
    else {
      expect(first.kind).toBe('recovery-required')
      expect((await capture.settle()).kind).toBe('ready')
    }
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    const managed = join(root, 'context-output', hash('w'), 'managed-v1')
    const ids = await readdir(managed)
    expect(ids).toHaveLength(1)
    const pins = await readdir(join(managed, ids[0]!, 'pins'))
    expect(pins).toHaveLength(failure === 'quota' ? 1 : 2)
    expect(reads).toBe(1)
  } finally { await service.close(); await rm(root, { recursive: true, force: true }) }
})
