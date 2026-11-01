import { committedFactSeqs } from '@i-harness/core-session'
import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createJsonlSessionCoordinator, createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createSessionService } from '@i-harness/session-executor'
import { createAgentProcesses } from '../src/agent-processes.ts'
import { createAgentProcessReadRunner, type AgentProcessReadRunner } from '../src/agent-process-read.ts'
import { createSessionManagementFence } from '../src/session-management-fence.ts'
import { recordFixture } from './managed-fixture.ts'

it.each(['output', 'list'] as const)('managed final suffix revokes selected saved terminal %s while unrelated append stays valid', async mode => {
  for (const change of ['unrelated', 'rewind'] as const) {
    const root = await mkdtemp(join(tmpdir(), 'terminal-publication-')), coordinator = createJsonlSessionCoordinator(root, { lock: { enabled: true } })
    await coordinator.create({ sessionId: 's' }); const doc = await coordinator.openManagedDocument('s')
    await recordFixture(doc, { type: 'tool/call', callId: 'open', name: 'terminal_open', args: { command: 'owned' } })
    await recordFixture(doc, { type: 'tool/result', callId: 'open', name: 'terminal_open', output: { id: 'pty', pid: 1 } })
    await recordFixture(doc, { type: 'tool/call', callId: 'read', name: 'terminal_read', args: { id: 'pty', offset: 0 } })
    await recordFixture(doc, { type: 'tool/result', callId: 'read', name: 'terminal_read', output: { id: 'pty', data: 'saved', nextOffset: 5 } })
    const service = createSessionService({ workspace: root, coordinator }), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const real = createAgentProcessReadRunner({ coordinator, service, fence: createSessionManagementFence(), isConversation: async () => true, resultReadScopeFor: async () => undefined })
    const held: AgentProcessReadRunner = (id, work) => real(id, async context => { const result = await work(context); entered.resolve(); await release.promise; return result })
    const processes = createAgentProcesses(coordinator, service, { runRead: held })
    try {
      const reading = mode === 'output' ? processes.terminalOutput('s', 'pty') : processes.read('s')
      const result = reading.then(value => ({ value }), error => ({ error }))
      await entered.promise
      if (change === 'rewind') await recordFixture(doc, { type: 'rewind/point', version: 1, targetTurn: 0, mode: 'conversation', fileOps: [], anchorSeq: doc.view.events[2]!.seq! })
      else await recordFixture(doc, { type: 'assistant/message', text: 'unrelated' })
      release.resolve(); const outcome = await result
      if (change === 'rewind') expect(outcome).toHaveProperty('error')
      else expect(outcome).toHaveProperty('value')
      expect(service.hasAssembly('s')).toBe(false)
    } finally { release.resolve(); await service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
  }
})
it.each(['document', 'profile'] as const)('two-argument saved compatibility revalidates original declaration across %s await', async phase => {
  for (const change of ['unrelated', 'rewind', 'competitor'] as const) {
    const root = await mkdtemp(join(tmpdir(), 'compat-publication-')), coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
    await coordinator.create({ sessionId: 's' }); const doc = await coordinator.openManagedDocument('s')
    await recordFixture(doc, { type: 'tool/call', callId: 'start', name: 'shell', args: {} })
    await recordFixture(doc, { type: 'tool/result', callId: 'start', name: 'shell', output: { job_id: 'job' } })
    await recordFixture(doc, { type: 'tool/call', callId: 'read', name: 'job_output', args: { job_id: 'job' } })
    await recordFixture(doc, { type: 'tool/result', callId: 'read', name: 'job_output', output: { text: 'private prefix', truncated: false } })
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let profiles = 0
    const held = { ...coordinator, async getDocument(id: string) { if (phase === 'document') { entered.resolve(); await release.promise }; return coordinator.getDocument(id) }, async profile(id: string) { if (++profiles === 2 && phase === 'profile') { entered.resolve(); await release.promise }; return coordinator.profile(id) } }
    const service = createSessionService({ workspace: root, coordinator }), processes = createAgentProcesses(held, service)
    try {
      const result = processes.jobOutput('s', 'job').then(value => ({ value }), error => ({ error }))
      await entered.promise
      if (change === 'rewind') await recordFixture(doc, { type: 'rewind/point', version: 1, targetTurn: 0, mode: 'conversation', fileOps: [], anchorSeq: doc.view.events[0]!.seq! })
      else if (change === 'unrelated') await recordFixture(doc, { type: 'assistant/message', text: 'unrelated append' })
      else { await recordFixture(doc, { type: 'tool/call', callId: 'other', name: 'shell', args: {} }); await recordFixture(doc, { type: 'tool/result', callId: 'other', name: 'shell', output: { job_id: 'job' } }) }
      release.resolve(); expect(await result).toHaveProperty(change === 'unrelated' ? 'value' : 'error')
      expect(service.hasAssembly('s')).toBe(false)
    } finally { release.resolve(); await service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
  }
})

it('terminal fixed windows preserve original PTY string offsets and overlap behavior for multibyte text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'terminal-offsets-')), coordinator = createJsonlSessionCoordinator(root, { lock: { enabled: true } })
  await coordinator.create({ sessionId: 's' }); const doc = await coordinator.openManagedDocument('s'), service = createSessionService({ workspace: root, coordinator })
  try {
    await recordFixture(doc, { type: 'tool/call', callId: 'open', name: 'terminal_open', args: {} })
    await recordFixture(doc, { type: 'tool/result', callId: 'open', name: 'terminal_open', output: { id: 'pty' } })
    for (const [callId, data, offset, nextOffset] of [['a', 'A😀B', 0, 4], ['b', '😀BC', 1, 5]] as const) {
      await recordFixture(doc, { type: 'tool/call', callId, name: 'terminal_read', args: { id: 'pty', offset } })
      await recordFixture(doc, { type: 'tool/result', callId, name: 'terminal_read', output: { id: 'pty', data, nextOffset } })
    }
    const processes = createAgentProcesses(coordinator, service, { runRead: createAgentProcessReadRunner({ coordinator, service, fence: createSessionManagementFence(), isConversation: async () => true, resultReadScopeFor: async () => undefined }) })
    expect(await processes.terminalOutput('s', 'pty')).toMatchObject({ text: 'A😀BC', dropped: false, live: false })
  } finally { await service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
const terminalPendingCases = (['output', 'list'] as const).flatMap(mode => (['initial', 'suffix'] as const).flatMap(split => (['legacy', 'inline'] as const).flatMap(format => (['same', 'other'] as const).map(target => [mode, split, format, target] as const))))
it.each(terminalPendingCases)('terminal pending parity %s/%s/%s/%s uses actual final managed suffix', async (mode, split, format, target) => {
  const root = await mkdtemp(join(tmpdir(), 'terminal-pending-')), coordinator = createJsonlSessionCoordinator(root, { lock: { enabled: true } })
  await coordinator.create({ sessionId: 's' }); const doc = await coordinator.openManagedDocument('s')
  await recordFixture(doc, { type: 'tool/call', callId: 'old-open', name: 'terminal_open', args: {} })
  await recordFixture(doc, { type: 'tool/result', callId: 'old-open', name: 'terminal_open', output: { id: 'pty' } })
  await recordFixture(doc, { type: 'tool/call', callId: 'old-read', name: 'terminal_read', args: { id: 'pty', offset: 0 } })
  await recordFixture(doc, { type: 'tool/result', callId: 'old-read', name: 'terminal_read', output: { id: 'pty', data: 'original', nextOffset: 8 } })
  async function pendingCall() {
    const action = doc.beginAction()
    try {
      const seq = committedFactSeqs(await action.facts.tools.call({ type: 'tool/call', callId: 'new-open', name: 'terminal_open', args: {} }))[0]!
      committedFactSeqs(await action.facts.tools.dispatch('new-open', { kind: 'prior', seq, expectedType: 'tool/call' }))
    } finally { action.finish() }
  }
  if (split === 'initial') await pendingCall()
  const service = createSessionService({ workspace: root, coordinator }), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const original = createAgentProcessReadRunner({ coordinator, service, fence: createSessionManagementFence(), isConversation: async () => true, resultReadScopeFor: async () => undefined })
  const held: AgentProcessReadRunner = (id, work) => original(id, async context => { const result = await work(context); entered.resolve(); await release.promise; return result })
  const processes = createAgentProcesses(coordinator, service, { runRead: held })
  try {
    const reading = mode === 'output' ? processes.terminalOutput('s', 'pty') : processes.read('s')
    const outcome = reading.then(value => ({ value }), error => ({ error }))
    await entered.promise
    if (split === 'suffix') await pendingCall()
    const value = { id: target === 'same' ? 'pty' : 'other', ownerSessionId: 's' }
    await recordFixture(doc, { type: 'tool/result', callId: 'new-open', name: 'terminal_open', ...(format === 'legacy' ? { output: value } : { envelope: { version: 1, execution: { outcome: 'succeeded', dispatch: 'dispatched' }, preview: '', media: [], retention: { kind: 'inline', value, encodedBytes: Buffer.byteLength(JSON.stringify(value)) } } }) })
    release.resolve(); expect(await outcome).toHaveProperty(target === 'same' ? 'error' : 'value')
    expect(service.hasAssembly('s')).toBe(false)
  } finally { release.resolve(); await service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
