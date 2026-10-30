import { expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContext } from '@i-harness/core-plugin'
import { createSession, createNondurableFactOwner } from '@i-harness/core-session'
import { createToolRegistry } from '@i-harness/core-tools'
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts'
import { createLoopbackProvider } from '../../core-agent/test/helpers/provider-loopback.ts'
import { registerSubagent } from '../../subagent/src/index.ts'
import { createTeammateSpawner } from '../../agent-team/src/scheduler/teammate-lifecycle.ts'
import { runGuardianReview } from '../../guard-approval/src/guardian/reviewer.ts'
import { createProjectInstructionEnvironment } from '../src/context/instructions/host.ts'
import { createMainInstructionManager } from '../src/context/instructions/manager.ts'
import { createChildInstructionHost } from '../src/context/instructions/child-host.ts'
import { rmWorkspaceSync } from './helpers.ts'

it.each(['team', 'reviewer'] as const)('publishes an independent %s instruction view in its first actual provider request', async kind => {
  const cwd = await mkdtemp(join(tmpdir(), 'ih-first-consumer-')); await writeFile(join(cwd, 'AGENTS.md'), 'FIRST_CONSUMER_RULE')
  const environment = createProjectInstructionEnvironment(), parent = createSession(), parentOwner = createNondurableFactOwner(parent), ctx = createContext(), registry = createToolRegistry(ctx)
  const options = { cwd, environment, authority: () => ({ kind: 'unbound' as const, revision: '1', workspaceRoot: cwd }), available: () => true }
  const manager = createMainInstructionManager({ ...options, session: parent, publish: async () => {} }), host = createChildInstructionHost({ ...options, root: { session: parent, factOwner: parentOwner, manager } })
  const answer = kind === 'reviewer' ? JSON.stringify({ outcome: 'approve', rationale: 'safe', risk_level: 'none' }) : 'done'
  const server = await createLoopbackProvider('/v1/chat/completions', [async response => { response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: answer }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`) }])
  const model = createOpenAICompatibleClient({ apiKey: 'fixture', model: 'fixture', baseUrl: server.baseUrl }), resolveModel = async () => ({ status: 'unconfigured' as const, reason: 'unused' })
  const subagent = registerSubagent(ctx, registry, { parentSession: parent, parentModel: model, exec: {} as never, resolveModel, createInstructionContext: host.create })
  try {
    await subagent.ready
    const shared = { roles: subagent.roles, jobs: subagent.jobs, table: subagent.table, agents: subagent.agents, resolveModel, createInstructionContext: host.create, retainInitialSetup: subagent.retainInitialSetup }
    if (kind === 'team') {
      const spawn = createTeammateSpawner(ctx, { parentRegistry: registry, parentSession: parent, parentModel: model }, shared as never, subagent.jobs, () => [], { notify() {} } as never)
      const result = await spawn('member', 'work', 'fresh'); await subagent.table.get(result.path)!.followupChain
      expect(subagent.table.get(result.path)!.session.events.some(event => event.type === 'runtime/context')).toBe(true)
    } else {
      const verdict = await runGuardianReview({ subagents: shared, parentRegistry: registry, parentSession: parent, parentCtx: ctx, parentModel: model, resolveModel, createInstructionContext: host.create, retainInitialSetup: subagent.retainInitialSetup } as never, { name: 'write', reason: 'review', args: {} })
      expect(verdict.outcome).toBe('approve')
    }
    expect(server.requests).toHaveLength(1); expect(server.errors).toEqual([]); expect(JSON.stringify(server.requests[0]!.body)).toContain('FIRST_CONSUMER_RULE')
    expect(parent.events.some(event => event.type === 'runtime/context')).toBe(false)
  } finally { await subagent.dispose().catch(() => {}); await host.close().catch(() => {}); await manager.close().catch(() => {}); await environment.close(); await server.close(); rmWorkspaceSync(cwd) }
})

it('forwards the original instruction factory through the actual spawn_agent tool', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'ih-first-ordinary-')); await writeFile(join(cwd, 'AGENTS.md'), 'ORDINARY_FIRST_RULE')
  const environment = createProjectInstructionEnvironment(), parent = createSession(), parentOwner = createNondurableFactOwner(parent), ctx = createContext(), registry = createToolRegistry(ctx)
  const options = { cwd, environment, authority: () => ({ kind: 'unbound' as const, revision: '1', workspaceRoot: cwd }), available: () => true }
  const manager = createMainInstructionManager({ ...options, session: parent, publish: async () => {} }), host = createChildInstructionHost({ ...options, root: { session: parent, factOwner: parentOwner, manager } })
  const server = await createLoopbackProvider('/v1/chat/completions', [async response => { response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`) }])
  const model = createOpenAICompatibleClient({ apiKey: 'fixture', model: 'fixture', baseUrl: server.baseUrl }), resolveModel = async () => ({ status: 'unconfigured' as const, reason: 'unused' })
  const subagent = registerSubagent(ctx, registry, { parentSession: parent, parentModel: model, exec: {} as never, resolveModel, createInstructionContext: host.create })
  try {
    await subagent.ready; subagent.roles.register({ name: 'reader', description: '', systemPrompt: 'reader', tools: [] })
    const output = await registry.get('spawn_agent')!.execute({ task_name: 'ordinary', message: 'work', agent_type: 'reader', background: false }, { session: parent }) as { agent_path: string }
    expect(subagent.table.get(output.agent_path)!.session.events.some(event => event.type === 'runtime/context')).toBe(true)
    expect(server.requests).toHaveLength(1); expect(JSON.stringify(server.requests[0]!.body)).toContain('ORDINARY_FIRST_RULE')
    expect(parent.events.some(event => event.type === 'runtime/context')).toBe(false)
  } finally { await subagent.dispose().catch(() => {}); await host.close().catch(() => {}); await manager.close().catch(() => {}); await environment.close(); await server.close(); rmWorkspaceSync(cwd) }
})
