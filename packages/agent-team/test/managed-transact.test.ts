import { expect, it } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { committedFactSeqs, decodeFactBatch, type BatchKey } from '@i-harness/core-session'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { createTeamTransact, createFoldState, type TeamEvent } from '../src/index.ts'

it('publishes a whole team transaction only after the original atomic receipt and never reruns the transaction on unknown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-team-tx-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id), state = createFoldState()
  const captured = new WeakMap<readonly TeamEvent[], ReturnType<ReturnType<typeof document.beginAction>['captureTeamTransaction']>>()
  const tx = createTeamTransact({ async commit(events) {
    let fact = captured.get(events)
    if (!fact) { const action = document.beginAction(); fact = action.captureTeamTransaction(events); captured.set(events, fact) }
    committedFactSeqs(await fact.admit())
  } }, state)
  let runs = 0, writes = 0, key: BatchKey|undefined
  const actual = backend.appendOwnedBatch!
  backend.appendOwnedBatch = async (...args) => { writes++; await actual(...args); key = args[3].key; return { kind: 'unknown', key } }
  try {
    await expect(tx.transact(() => {
      runs++
      return { events: [
        { type: 'team/member', version: 1, teamId: 't', member: { id: 'm', name: 'member', description: '', provider: 'fixture', context: 'fresh', phase: 'provisioning' } },
        { type: 'team/member', version: 1, teamId: 't', member: { id: 'm', name: 'member', description: '', provider: 'fixture', context: 'fresh', phase: 'active' } },
      ], result: true }
    })).rejects.toThrow()
    expect(state.members.size).toBe(0); expect(document.view.events).toHaveLength(0)
    expect(decodeFactBatch(Buffer.from((await readFile(join(root, `${id}.jsonl`), 'utf8')).split('\n')[1]!+'\n')).events).toHaveLength(2)
    await document.reconcile(key!)
    await tx.drain()
    expect(state.members.get('member')?.phase).toBe('active'); expect([runs, writes]).toEqual([1, 1])
  } finally { await coordinator.close().catch(() => {}) }
})
