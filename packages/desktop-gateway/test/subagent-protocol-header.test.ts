import { expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createSubagentVisibility } from '../src/session-visibility.ts'
import { createNativeConsumerOwners } from './helpers/native-consumer-fixture.ts'
import { toJSONL } from '@i-harness/core-session'

const reviewerText = 'An agent requests execution of a tool call. Decide: approve (execute now, never ask the user),\nallow (ask the user first), or deny (never execute).\n<request>x</request>\n<recent_context>x</recent_context>\nOutput STRICT JSON only'

it('preserves current creation markers through metadata/cold owned reopen and keeps literal9 reviewer classification after upgrade', async () => {
  const root = await mkdtemp(join(tmpdir(), 'child-protocol-header-'))
  const backend = createJsonlBackend(root)
  let coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  let owners: Awaited<ReturnType<typeof createNativeConsumerOwners>> | undefined
  try {
    await coordinator.create({ sessionId: 'parent' })
    await coordinator.create({ sessionId: 'current', origin: 'subagent', parentSession: 'parent', seedLength: 0, subagentProtocolVersion: 1 })
    await coordinator.append('current', [{ type: 'turn/start', seq: 0 }, { type: 'user/message', text: reviewerText, seq: 1 }, { type: 'assistant/message', text: 'ordinary result', seq: 2 }, { type: 'turn/end', seq: 3 }])
    expect((await coordinator.openManagedDocument('current')).view.header?.subagentProtocolVersion).toBe(1)
    await coordinator.updateMeta('current', { title: 'preserved' })
    await coordinator.create({ sessionId: 'reviewer', origin: 'approval-review', parentSession: 'parent', seedLength: 0 })
    await writeFile(join(root, 'old.jsonl'), toJSONL({ formatVersion: 9, header: { sessionId: 'old', createdAt: '', origin: 'subagent', parentSession: 'parent', seedLength: 0 } as any, events: [{ type: 'user/message', text: reviewerText, seq: 0 }] }))
    await coordinator.ensureWritableFormat!('old')
    expect((await coordinator.profile('old')).meta).toMatchObject({ formatVersion: 13 })
    expect((await coordinator.profile('old')).meta).not.toHaveProperty('subagentProtocolVersion')
    await coordinator.close()
    coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
    const profile = await coordinator.profile('current')
    expect(profile.meta).toMatchObject({ subagentProtocolVersion: 1, title: 'preserved' })
    expect((await coordinator.openManagedDocument('current')).view.header?.subagentProtocolVersion).toBe(1)
    const visible = createSubagentVisibility(coordinator), snapshots = vi.spyOn(coordinator, 'snapshot')
    expect(await visible('current', profile.meta)).toBe(true)
    expect(snapshots).not.toHaveBeenCalled()
    expect(await visible('reviewer', (await coordinator.profile('reviewer')).meta)).toBe(false)
    expect(await visible('old', (await coordinator.profile('old')).meta)).toBe(false)
    expect(snapshots).toHaveBeenCalledWith('old')
    expect(await visible('invalid', { ...profile.meta, subagentProtocolVersion: 2 } as any)).toBe(false)
    owners = await createNativeConsumerOwners(coordinator, root)
    const fork = await owners.fork('current')
    expect((await coordinator.profile(fork.sessionId)).meta).not.toHaveProperty('subagentProtocolVersion')
    await expect(coordinator.updateMeta('old', { subagentProtocolVersion: 1 })).rejects.toThrow(/immutable/)
  } finally { await owners?.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
