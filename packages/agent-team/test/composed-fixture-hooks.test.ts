import { expect, it } from 'vitest'
import { createTeamFacts } from '../src/facts.ts'
import { createTeamTransact, type DeliveryOutcome } from '../src/transact.ts'
import { createMailbox } from '../src/mailbox.ts'
import { createFoldState } from '../src/fold.ts'
import { ownedTeamFixture } from './owned-fixture.ts'

it('lets a composed fixture observe owned batches and reconciles through pre-bind hooks (D-12)', async () => {
  const appends: unknown[] = [], reconciles: number[] = []
  const f = await ownedTeamFixture([], 'team', {
    composed: true,
    control: {
      append: original => (...args) => { appends.push(args[3]); return original(...args) },
      reconcile: original => (...args) => { reconciles.push(1); return original(...args) },
    },
  })
  try {
    const state = createFoldState()
    state.members.set('helper', { id: 'child', name: 'helper', description: '', provider: 'fixture', context: 'fresh', phase: 'active' })
    let tx: ReturnType<typeof createTeamTransact>
    const lead = createTeamFacts(f.document, () => tx.drain(), () => {})
    tx = createTeamTransact(lead, state)
    const queued = (): DeliveryOutcome => ({ kind: 'queued', via: 'bridge-false', sendFailure: { occurred: false } })
    const mailbox = createMailbox({ teamId: 'team', state, transact: tx, deliver: async () => queued(), memberStatus: () => 'idle', maxPendingMessagesPerMember: 8 })
    await expect(mailbox.sendMessage({ id: 'team', name: 'lead', role: 'lead' }, 'helper', 'hello', 'quiet')).resolves.toMatchObject({ status: 'queued' })
    expect(appends.length).toBeGreaterThan(0)
    expect(appends[0]).toHaveProperty('key')
    expect(reconciles).toEqual([])
  } finally {
    await f.coordinator.close().catch(() => {})
  }
})

it('honours an append hook assigned after fixture creation (D-12)', async () => {
  const appends: unknown[] = []
  const f = await ownedTeamFixture([], 'team', { composed: true })
  try {
    f.control.append = original => (...args) => { appends.push(args[3]); return original(...args) }
    const state = createFoldState()
    state.members.set('helper', { id: 'child', name: 'helper', description: '', provider: 'fixture', context: 'fresh', phase: 'active' })
    let tx: ReturnType<typeof createTeamTransact>
    const lead = createTeamFacts(f.document, () => tx.drain(), () => {})
    tx = createTeamTransact(lead, state)
    const queued = (): DeliveryOutcome => ({ kind: 'queued', via: 'bridge-false', sendFailure: { occurred: false } })
    const mailbox = createMailbox({ teamId: 'team', state, transact: tx, deliver: async () => queued(), memberStatus: () => 'idle', maxPendingMessagesPerMember: 8 })
    await expect(mailbox.sendMessage({ id: 'team', name: 'lead', role: 'lead' }, 'helper', 'hello', 'quiet')).resolves.toMatchObject({ status: 'queued' })
    expect(appends.length).toBeGreaterThan(0)
  } finally { await f.coordinator.close().catch(() => {}) }
})
it('supports a composed fixture created with a seed transaction (D-12)', async () => {
  const f = await ownedTeamFixture([{ type: 'team/member', version: 1, teamId: 'team', member: { id: 'm', name: 'm', description: '', provider: 'p', context: 'fresh', phase: 'active' } }], 'team', { composed: true })
  try { expect(f.document.view.events.map(event => event.type)).toEqual(['team/member']) }
  finally { await f.coordinator.close().catch(() => {}) }
})