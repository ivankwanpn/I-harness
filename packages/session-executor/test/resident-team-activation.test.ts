import { expect, it, vi } from 'vitest'
const controls = vi.hoisted(() => ({ team: undefined as import('@i-harness/agent-team').TeamMountHandle | undefined }))
vi.mock('@i-harness/agent-team', async original => {
  const native = await original<typeof import('@i-harness/agent-team')>()
  return { ...native, async mountAgentTeams(...args: Parameters<typeof native.mountAgentTeams>) {
    const [ctx, tools, deps, ...rest] = args, retain = deps.retainMount
    return native.mountAgentTeams(ctx, tools, { ...deps, retainMount(handle) { controls.team = handle; retain?.(handle) } }, ...rest)
  } }
})
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { committedFactSeqs } from '@i-harness/core-session'
import { builtinRoles, type SubagentStateSnapshot } from '@i-harness/subagent'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createSessionService } from '../src/service.ts'
import { controlledModel } from './controlled-model.ts'

it.each(['publish', 'partial-close'] as const)('keeps Team recoverRoot ACK data-ready while original wakeup waits for publication (%s)', async mode => {
  controls.team = undefined
  const root = await mkdtemp(join(process.env.IH_CONFIG_DIR!, 'team-'))
  await writeFile(join(root, 'settings.json'), '{}')
  const coordinator = createSessionCoordinator(createJsonlBackend(join(root, 'sessions')), { lock: { enabled: true } })
  await coordinator.create({ sessionId: 'parent' })
  const parent = await coordinator.openManagedDocument('parent'), action = parent.beginAction()
  try { committedFactSeqs(await action.captureTeamTransaction([
    { type: 'team/member', version: 1, teamId: 'original-team', member: { id: 'child-id', name: 'helper', description: 'd', provider: 'spawn', context: 'fresh', phase: 'provisioning' } },
    { type: 'team/member', version: 1, teamId: 'original-team', member: { id: 'child-id', name: 'helper', description: 'd', provider: 'spawn', context: 'fresh', phase: 'active', sessionId: 'child' } },
    { type: 'team/message/queued', version: 1, teamId: 'original-team', message: { id: 'original-message', senderId: 'original-team', senderName: 'lead', targetId: 'child-id', delivery: 'wakeup', content: 'one original delivery' } },
  ]).admit()) } finally { action.finish() }
  await parent.close(); await coordinator.create({ sessionId: 'child', parentSession: 'parent', origin: 'subagent' })
  const restoredState: SubagentStateSnapshot = { formatVersion: 2, jobs: [], roles: builtinRoles(), agentTable: [{ path: 'lead/helper', status: 'waiting', mailbox: [], sessionId: 'child', roleName: 'general', lastInboxSeq: -1 }] }
  const mounted = Promise.withResolvers<import('../src/assembly.ts').SessionAssembly>(), release = Promise.withResolvers<void>()
  let requests = 0
  const service = createSessionService({ workspace: root, coordinator, modelPolicy: 'test-mock', team: {}, restoredState, codeMode: { mode: 'off' }, contextOutputSettingsPath: join(root, 'settings.json'),
    model: controlledModel(async function* () { requests++; yield { type: 'text/chunk', text: 'done' }; yield { type: 'end' } }),
    extensionsFor: async () => ({ options: {}, async mount(assembly) { mounted.resolve(assembly); await release.promise } }) })
  const creating = service.assemblyFor('parent'); void creating.catch(() => {})
  try {
    const assembly = await mounted.promise, child = await coordinator.openManagedDocument('child')
    expect(assembly.session.events.filter(e => e.type === 'team/message/delivered')).toHaveLength(1)
    expect(child.view.events.filter(e => e.type === 'subagent/inbox')).toHaveLength(1)
    console.info('resident-team-activation-evidence', JSON.stringify({ phase: 'before-publication', mode, root, requests,
      originalInbox: child.view.events.filter(e => e.type === 'subagent/inbox'),
      originalAck: assembly.session.events.filter(e => e.type === 'team/message/delivered'),
      originalGeneration: child.view.events.filter(e => e.type === 'context/action' && e.op === 'open') }))
    expect(child.view.events.filter(e => e.type === 'context/action' || e.type === 'user/message')).toEqual([])
    expect(requests).toBe(0)
    if (mode === 'partial-close') await controls.team!.unmount()
    release.resolve(); expect(await creating).toBe(assembly)
    if (mode === 'publish') {
      await expect.poll(() => requests).toBe(1)
      await expect.poll(() => assembly.subagentState().agentTable[0]?.result?.kind).toBe('retained')
    }
    expect(requests).toBe(mode === 'publish' ? 1 : 0)
    expect(assembly.session.events.filter(e => e.type === 'team/message/delivered')).toHaveLength(1)
    expect(child.view.events.filter(e => e.type === 'subagent/inbox')).toHaveLength(1)
    console.info('resident-team-activation-evidence', JSON.stringify({ phase: 'after-publication', mode, root, requests,
      originalInbox: child.view.events.filter(e => e.type === 'subagent/inbox'),
      originalAck: assembly.session.events.filter(e => e.type === 'team/message/delivered'),
      originalGeneration: child.view.events.filter(e => e.type === 'context/action' && e.op === 'open') }))
  } finally { release.resolve(); await creating.catch(() => {}); await service.close(); await coordinator.close() }
}, 20_000)
