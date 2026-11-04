import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { composeJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/backend-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createTeamFacts } from '../src/facts.ts'
import { createTeamTransact, type DeliveryOutcome } from '../src/transact.ts'
import { createMailbox } from '../src/mailbox.ts'
import { createFoldState } from '../src/fold.ts'

/** D-12 boundary: a plain team write is accepted by the composed coordinator.
 * The acknowledgement-settlement failures are therefore harness-specific
 * (beginAction/ack-source wrappers), not a blanket prepareWrite rejection. */
it('accepts a plain team message write on the composed coordinator', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-team-composed-'))
  const coordinator = composeJsonlTaskTransitionCoordinator(createJsonlBackend(root), { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    await coordinator.create({ sessionId: 'team' })
    const document = await coordinator.openManagedDocument('team')
    const state = createFoldState()
    state.members.set('helper', { id: 'child', name: 'helper', description: '', provider: 'fixture', context: 'fresh', phase: 'active' })
    let tx: ReturnType<typeof createTeamTransact>
    const lead = createTeamFacts(document, () => tx.drain(), () => {})
    tx = createTeamTransact(lead, state)
    const queued = (): DeliveryOutcome => ({ kind: 'queued', via: 'bridge-false', sendFailure: { occurred: false } })
    const mailbox = createMailbox({ teamId: 'team', state, transact: tx, deliver: async () => queued(), memberStatus: () => 'idle', maxPendingMessagesPerMember: 8 })
    await expect(mailbox.sendMessage({ id: 'team', name: 'lead', role: 'lead' }, 'helper', 'hello', 'quiet')).resolves.toMatchObject({ status: 'queued' })
    expect((await coordinator.snapshot!('team')).session.events.some(event => event.type.startsWith('team/'))).toBe(true)
  } finally {
    await coordinator.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})

it('completes an accepted team message delivery on the composed coordinator', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-team-deliver-'))
  const coordinator = composeJsonlTaskTransitionCoordinator(createJsonlBackend(root), { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    await coordinator.create({ sessionId: 'team' })
    const document = await coordinator.openManagedDocument('team')
    const state = createFoldState()
    state.members.set('helper', { id: 'child', name: 'helper', description: '', provider: 'fixture', context: 'fresh', phase: 'active' })
    let tx: ReturnType<typeof createTeamTransact>
    const lead = createTeamFacts(document, () => tx.drain(), () => {})
    tx = createTeamTransact(lead, state)
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<DeliveryOutcome>()
    const mailbox = createMailbox({ teamId: 'team', state, transact: tx, memberStatus: () => 'idle', maxPendingMessagesPerMember: 8,
      deliver: async () => { entered.resolve(); return release.promise } })
    const sending = mailbox.sendMessage({ id: 'team', name: 'lead', role: 'lead' }, 'helper', 'hello', 'quiet')
    await entered.promise
    expect(document.view.events.map(event => event.type)).toEqual(['team/message/queued'])
    release.resolve({ kind: 'consumed', via: 'target', sendFailure: { occurred: false } })
    await expect(sending).resolves.toMatchObject({ status: 'accepted' })
    expect(document.view.events.map(event => event.type)).toEqual(['team/message/queued', 'team/message/delivered'])
  } finally {
    await coordinator.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})
