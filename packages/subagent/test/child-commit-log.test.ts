import { fixtureGenerationFor, controlledModel } from './generation-fixture.ts'
import { createSummaryPort } from '../../compaction/src/index.ts'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { createContext } from '@i-harness/core-plugin'
import { createSession, deriveMessages } from '@i-harness/core-session'
import { createToolRegistry } from '@i-harness/core-tools'
import { createMockClient } from '@i-harness/llm-mock'
import { createAgentRegistry } from '@i-harness/core-agent'
import { createJobRegistry } from '../src/jobs.ts'
import { createRoleRegistry } from '../src/roles.ts'
import { createAgentTable } from '../src/agent-table.ts'
import { spawnChild } from '../src/child.ts'
import { createJsonlCommitCoordinator } from '../../session-persistence-jsonl/src/commit-coordinator.ts'
import { asSessionCoordinator } from '@i-harness/session-persistence/internal/commit-facade'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

const noRoleModel = async () => ({ status: 'unconfigured' as const, reason: 'unused' })

describe('subagent child on the commit log', () => {
  it('creates the durable child, imports the seed and mirrors the run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ih-subagent-scl-'))
    roots.push(root)
    const coordinator = createJsonlCommitCoordinator(root, { lock: { enabled: true } })
    const jobs = createJobRegistry()
    const table = createAgentTable()
    const roles = createRoleRegistry()
    roles.register({ name: 'general', description: 'd', systemPrompt: 'p', tools: [] })
    const ctx = createContext()
    const parentRegistry = createToolRegistry(ctx)
    const parentSession = createSession()
    parentSession.events.push(
      { type: 'turn/start' } as never,
      { type: 'user/message', text: 'a' } as never,
      { type: 'assistant/message', text: 'b' } as never,
      { type: 'turn/end' } as never,
    )
    const mock = createMockClient([{ role: 'assistant', text: 'ok' }])
    const requests: import('@i-harness/llm-seam').LLMRequest[] = []

    try {
      const { path, sessionId } = await spawnChild({
        generationFactoryFor: fixtureGenerationFor,
        taskName: 'helper',
        message: 'hi',
        parentPath: 'root',
        parentRegistry,
        parentSession,
        parentCtx: ctx,
        role: roles.get('general')!,
        summaryFactory: createSummaryPort,
        parentModel: controlledModel(request => ({ stream(request: import('@i-harness/llm-seam').LLMRequest) { requests.push(request); return mock.stream(request) } }).stream(request)),
        resolveModel: noRoleModel,
        jobs,
        table,
        agents: createAgentRegistry(),
        childSessions: { coordinator: asSessionCoordinator(coordinator), parentSessionId: 'sess-main' },
        forkTurns: 'all',
      })
      expect(sessionId).toMatch(/^child-/)
      const child = table.get(path)
      expect(child).toBeDefined()
      await child!.followupChain
      const { session } = await coordinator.load(sessionId!)
      expect(session.header).toMatchObject({ parentSession: 'sess-main', origin: 'subagent', seedLength: 3, delegationDepth: 1 })
      expect(session.events.slice(0, 3).map(event => event.type)).toEqual([
        'conversation/seed-manifest', 'conversation/seed-group', 'conversation/seed-group',
      ])
      expect(session.events[0]).toMatchObject({ groupCount: 2 })
      expect(session.events[3]).toMatchObject({ type: 'session/bootstrap', seedLength: 3 })
      expect(session.events[4]).toMatchObject({ type: 'agent/input/admitted', text: 'hi' })
      expect(session.events.filter(event => event.type === 'agent/input/admitted')).toHaveLength(1)
      expect(session.events.map(event => event.seq)).toEqual(session.events.map((_, index) => index))
      expect(deriveMessages(session).slice(0, 2).map(({ role, content }) => ({ role, content }))).toEqual([
        { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' },
      ])
      expect(requests).toHaveLength(1)
      expect(requests[0]!.messages.slice(0, 2).map(({ role, content }) => ({ role, content }))).toEqual([
        { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' },
      ])
      expect(parentSession.events.map(event => event.type)).toEqual(['turn/start', 'user/message', 'assistant/message', 'turn/end'])
    } finally {
      const entries = [...table.entries().values()]
      const joined = await Promise.allSettled(entries.map(entry => entry.followupChain))
      const disposed = await Promise.allSettled(entries.map(entry => entry.dispose?.()))
      const failures = [...joined, ...disposed].flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      for (const close of [() => ctx.scope.unmount(), () => coordinator.close()]) {
        try { await close() } catch (error) { failures.push(error) }
      }
      if (failures.length) throw new AggregateError(failures, 'Original child fixture cleanup failed')
    }
  }, 30000)
})
