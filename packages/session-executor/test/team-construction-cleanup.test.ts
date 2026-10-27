import { describe, expect, it } from 'vitest'
import { decodeFactBatch, type BatchKey } from '@i-harness/core-session'
import { ownedTeamFixture } from '../../agent-team/test/owned-fixture.ts'
import { createSessionService } from '../src/service.ts'
import { createSessionAssembly } from '../src/assembly.ts'
import type { SubagentStateSnapshot } from '@i-harness/subagent'

async function recoveryFixture() {
  const f = await ownedTeamFixture([
    { type: 'team/member', version: 1, teamId: 'recovery-team', member: { id: 'child-id', name: 'helper', description: 'd', provider: 'spawn', context: 'fresh', phase: 'provisioning' } },
    { type: 'team/member', version: 1, teamId: 'recovery-team', member: { id: 'child-id', name: 'helper', description: 'd', provider: 'spawn', context: 'fresh', phase: 'active', sessionId: 'child' } },
    { type: 'team/message/queued', version: 1, teamId: 'recovery-team', message: { id: 'original-message', senderId: 'recovery-team', senderName: 'lead', targetId: 'child-id', delivery: 'quiet', content: 'recover exactly once' } },
  ], 'parent')
  await f.document.close()
  await f.coordinator.create({ sessionId: 'child', parentSession: 'parent' })
  const restoredState: SubagentStateSnapshot = { formatVersion: 2, jobs: [], roles: [], agentTable: [
    { path: 'lead/helper', status: 'waiting', mailbox: [], sessionId: 'child', roleName: 'general' },
  ] }
  await f.coordinator.putDocumentStrict!('parent', restoredState)
  const append = f.backend.appendOwnedBatch!, reconcile = f.backend.reconcileOwnedBatch!
  let allow = false, writes = 0
  const opened = new Set<object>()
  let ackKey: BatchKey | undefined
  const keys: BatchKey[] = [], captures: object[] = [], sources: object[] = [], receipts: unknown[] = []
  const open = f.coordinator.openManagedDocument.bind(f.coordinator)
  f.coordinator.openManagedDocument = async (...args) => {
    const document = await open(...args)
    if (args[0] === 'parent' && !opened.has(document)) {
      opened.add(document)
      const begin = document.beginAction.bind(document)
      document.beginAction = (...actionArgs) => {
        const action = begin(...actionArgs), register = action.registerSettlementSource.bind(action)
        action.registerSettlementSource = producer => {
          const source = register(producer), capture = source.delivery.capture.bind(source.delivery)
          source.delivery.capture = event => {
            const fact = capture(event)
            if (event.type === 'team/message/delivered') { sources.push(source); captures.push(fact) }
            return fact
          }
          return source
        }
        return action
      }
    }
    return document
  }
  f.backend.appendOwnedBatch = async (...args) => {
    const result = await append(...args)
    if (decodeFactBatch(args[3].bytes).events.some(event => event.type === 'team/message/delivered')) {
      writes++; ackKey = args[3].key
      const reported = { kind: 'unknown' as const, key: ackKey }
      receipts.push({ actual: result, reported }); return reported
    }
    return result
  }
  f.backend.reconcileOwnedBatch = async (...args) => {
    if (ackKey && args[3].key.batchId === ackKey.batchId) {
      keys.push(args[3].key)
      if (!allow) return { kind: 'unknown', key: args[3].key }
    }
    return reconcile(...args)
  }
  return { ...f, restoredState, allow: () => { allow = true }, counts: () => ({ writes, opens: opened.size }), captures, sources, keys, receipts, key: () => ackKey }
}

describe('Team construction cleanup ownership', () => {
  it.each(['service', 'session'] as const)('retains failed actual recovery in the original creating row and retries %s cleanup without rebuilding', async mode => {
    const f = await recoveryFixture()
    let builds = 0
    const service = createSessionService({ workspace: process.cwd(), coordinator: f.coordinator, restoredState: f.restoredState, modelPolicy: 'test-mock', team: {},
      extensionsFor: async () => { builds++; return { options: {} } },
    })
    const close = () => mode === 'service' ? service.close() : service.closeSession('parent')
    try {
      await expect(service.assemblyFor('parent')).rejects.toThrow()
      expect(f.captures).toHaveLength(1)
      const original = f.captures[0], source = f.sources[0]
      const child = await f.coordinator.snapshot!('child')
      expect(child.session.events.filter(event => event.type === 'subagent/inbox' && event.messageId === 'original-message')).toHaveLength(1)
      await expect(service.assemblyFor('parent')).rejects.toThrow(/cleanup incomplete/i)
      expect(builds).toBe(1)
      await expect(close()).rejects.toThrow(/cleanup incomplete/i)
      f.allow()
      await close()
      expect(f.counts()).toEqual({ writes: 1, opens: 1 })
      expect(f.captures).toHaveLength(1); expect(f.captures[0]).toBe(original)
      expect(f.sources).toHaveLength(1); expect(f.sources[0]).toBe(source)
      expect(f.keys.length).toBeGreaterThan(0)
      for (const key of f.keys) expect(key).toEqual(f.key())
      const parent = await f.coordinator.snapshot!('parent')
      expect(parent.session.events.filter(event => event.type === 'team/message/delivered')).toHaveLength(1)
      console.info('construction-cleanup-evidence', JSON.stringify({ mode, root: f.root, key: f.key(), keys: f.keys, receipts: f.receipts, counts: f.counts(), builds }))
    } finally { f.allow(); await service.close(); await f.coordinator.close() }
  })

  it('direct constructor failure carries its original cleanup closure for explicit retry', async () => {
    const f = await recoveryFixture()
    try {
      const failure = await createSessionAssembly({ workspace: process.cwd(), coordinator: f.coordinator, restoredState: f.restoredState, sessionId: 'parent', modelPolicy: 'test-mock', team: {} }).catch(error => error)
      expect(failure).toBeInstanceOf(AggregateError)
      expect(failure.cleanup).toBeTypeOf('function')
      await expect(failure.cleanup()).rejects.toThrow()
      f.allow(); await failure.cleanup()
      expect(f.counts()).toEqual({ writes: 1, opens: 1 })
    } finally { f.allow(); await f.coordinator.close() }
  })
})
