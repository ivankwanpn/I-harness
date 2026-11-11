import { expect, it, vi } from 'vitest'
import type { FileHandle } from 'node:fs/promises'
const native = vi.hoisted(() => ({
  root: '', blocked: false, commits: 0,
  writer: undefined as FileHandle | undefined,
  closes: [] as FileHandle[],
}))
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs, async open(...args: Parameters<typeof fs.open>) {
    const handle = await fs.open(...args)
    const path = String(args[0])
    if (native.root && path.startsWith(native.root) && /[\\/]child-[^\\/]+[\\/]/.test(path)) {
      const write = handle.write.bind(handle)
      handle.write = (async (...values: any[]) => {
        const result = await (write as any)(...values)
        if (Buffer.isBuffer(values[0]) && values[1] === 0 && result.bytesWritten > 0
          && values[0].includes(Buffer.from('agent/input/admitted'))) native.commits++
        return result
      }) as typeof handle.write
      if (!native.writer && args[1] === 'r+' && path.endsWith('session.v15.jsonl')) {
        native.writer = handle
        const close = handle.close.bind(handle)
        handle.close = async () => {
          native.closes.push(handle)
          if (native.blocked) throw false
          await close()
        }
      }
    }
    return handle
  } }
})
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry } from '@i-harness/core-tools'
import { createAgentRegistry } from '@i-harness/core-agent'
import { createSession } from '@i-harness/core-session'
import type { BootstrapGuards, BootstrapRequest } from '@i-harness/session-persistence'
import { asSessionCoordinator } from '@i-harness/session-persistence/internal/commit-facade'
import { createJsonlCommitCoordinator } from '../../session-persistence-jsonl/src/commit-coordinator.ts'
import { spawnChild } from '../src/child.ts'
import { createAgentTable } from '../src/agent-table.ts'
import { createJobRegistry } from '../src/jobs.ts'
import { fixtureGenerationFor, controlledModel } from './generation-fixture.ts'

function contains(error: unknown, value: unknown): boolean {
  return Object.is(error, value) || error instanceof AggregateError && error.errors.some(item => contains(item, value))
}

it('keeps original published commit ACK cleanup and revokes its failed observation before same-request recovery', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'host-commit-ack-'))
  const coordinator = asSessionCoordinator(createJsonlCommitCoordinator(root, { lock: { enabled: true, lockRoot: root } }))
  const ctx = createContext(), registry = createToolRegistry(ctx), table = createAgentTable()
  let request: BootstrapRequest | undefined, oldGuards: BootstrapGuards | undefined, models = 0
  const bootstrap = coordinator.bootstrapSemanticTarget
  const observation = vi.spyOn(coordinator, 'bootstrapSemanticTarget').mockImplementation((payload, guards) => {
    request = payload
    oldGuards = guards
    return bootstrap.call(coordinator, payload, guards)
  })
  native.root = root
  native.blocked = true
  native.writer = undefined
  native.closes = []
  native.commits = 0
  let primary: { cause: unknown } | undefined
  try {
    const failure = await spawnChild({
      generationFactoryFor: fixtureGenerationFor,
      taskName: 'host', message: 'original input', parentPath: 'root',
      parentCtx: ctx, parentRegistry: registry, parentSession: createSession(),
      childSessions: { coordinator, parentSessionId: 'parent' }, forkTurns: 'none',
      role: { name: 'probe', description: '', systemPrompt: 'probe', tools: [] },
      resolveModel: async () => ({ status: 'unconfigured', reason: 'unused' }),
      parentModel: controlledModel(async function* () { models++; throw Error('Unacknowledged birth must not issue a model request') }),
      table, jobs: createJobRegistry(), agents: createAgentRegistry(),
    }).then(() => { throw Error('Lost native close ACK must reject attachment') }, error => error)
    expect(contains(failure, false)).toBe(true)
    expect(native.commits).toBe(1)
    expect(native.writer!.fd).toBeGreaterThanOrEqual(0)
    expect(native.closes).toEqual([native.writer])
    expect({ models, entries: table.entries().size }).toEqual({ models: 0, entries: 0 })
    expect(request).toBeDefined()
    expect(() => oldGuards!.assertCurrent()).toThrow(expect.objectContaining({ reason: 'revoked' }))
    await expect(coordinator.close()).rejects.toThrow()
    expect(native.closes.every(handle => handle === native.writer)).toBe(true)
    expect(native.writer!.fd).toBeGreaterThanOrEqual(0)
    native.blocked = false
    await coordinator.close()
    expect(native.writer!.fd).toBe(-1)
    expect(native.closes).toHaveLength(3)
    expect(contains(failure, false)).toBe(true)
    observation.mockRestore()

    const cold = asSessionCoordinator(createJsonlCommitCoordinator(root, { lock: { enabled: true, lockRoot: root } }))
    try {
      const payload = request!
      const recovered = await cold.withSessionBindingObservation!({ existingSessionIds: [], target: payload.invocation }, async current => {
        const never = async (): Promise<never> => { throw Error('No result dependencies were requested') }
        return cold.resumeSemanticTarget(payload.invocation, {
          assertCurrent() { current.assertCurrent(); expect(current.binding(payload.invocation.targetSessionId)).toEqual({ kind: 'absent' }) },
          dependencies: { confirm: never, reconcile: never },
        }, payload)
      })
      expect(['ready', 'already-ready']).toContain(recovered.kind)
      if (recovered.kind !== 'ready' && recovered.kind !== 'already-ready') throw Error('Original committed birth was not recovered')
      expect(recovered.receipt.invocation).toEqual(payload.invocation)
      expect(recovered.receipt.initial!.expiresAt).toBe(payload.initial!.expiresAt)
      expect(recovered.document.view.events.filter(event => event.type === 'agent/input/admitted')).toHaveLength(1)
      expect(native.commits).toBe(1)
      expect(models).toBe(0)
      await recovered.document.close()
    } finally { await cold.close() }
  } catch (error) { primary = { cause: error }; throw error }
  finally {
    native.blocked = false
    observation.mockRestore()
    try { await coordinator.close(); await ctx.scope.unmount() } catch (cleanup) {
      if (primary) throw new AggregateError([primary.cause, cleanup], 'Original commit birth and cleanup failed', { cause: primary.cause })
      throw cleanup
    } finally { native.root = '' }
  }
}, 20000)
