import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { openCommitLog, type CommitLog } from '../../session-commit-log/src/store.ts'
import { createJsonlCommitCoordinator } from '../src/commit-coordinator.ts'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('ih-commit-input-admission-')) throw Error('Unsafe fixture cleanup')
    await rm(root, { recursive: true, force: true })
  }
})

it.each(['append', 'enqueue'] as const)('captures %s events at public admission before waiting for the original writer lease', async method => {
  const root = await mkdtemp(join(tmpdir(), 'ih-commit-input-admission-')); roots.push(root)
  const coordinator = createJsonlCommitCoordinator(root, { acquireRetryMs: 5, acquireDeadlineMs: 1000 })
  let blocker: CommitLog | undefined, accepted: Promise<void> | undefined
  try {
    await coordinator.create({ sessionId: 'source' })
    blocker = await openCommitLog({ root, sessionId: 'source' }, 'write')
    const events = [{ type: 'user/message' as const, text: 'admitted' }]
    if (method === 'append') accepted = coordinator.append('source', events)
    else coordinator.enqueue('source', events)
    events[0]!.text = 'mutated after admission'
    events.push({ type: 'user/message', text: 'added after admission' })
    await blocker.close(); blocker = undefined
    if (accepted) await accepted
    await coordinator.flush('source')
    expect((await coordinator.snapshot('source')).session.events).toEqual([{ type: 'user/message', text: 'admitted', seq: 0 }])
  } finally { await blocker?.close(); await accepted?.catch(() => undefined); await coordinator.close() }
}, 15000)

it('captures a metadata patch and nested model selection at admission before the original writer lease wait', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-commit-input-admission-')); roots.push(root)
  const coordinator = createJsonlCommitCoordinator(root, { acquireRetryMs: 5, acquireDeadlineMs: 1000 })
  let blocker: CommitLog | undefined, accepted: Promise<unknown> | undefined
  try {
    await coordinator.create({ sessionId: 'source' })
    blocker = await openCommitLog({ root, sessionId: 'source' }, 'write')
    const patch = { title: 'admitted title', modelSelection: { provider: 'fixture', model: 'admitted model' } }
    accepted = coordinator.updateMeta('source', patch)
    patch.title = 'mutated title'; patch.modelSelection.model = 'mutated model'
    await blocker.close(); blocker = undefined
    await accepted
    expect((await coordinator.profile('source')).meta).toMatchObject({ title: 'admitted title', modelSelection: { provider: 'fixture', model: 'admitted model' } })
  } finally { await blocker?.close(); await accepted?.catch(() => undefined); await coordinator.close() }
}, 15000)
