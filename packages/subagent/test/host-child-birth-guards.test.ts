import { expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { append, createSession, decodeFactBatch } from '@i-harness/core-session'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry } from '@i-harness/core-tools'
import { createAgentRegistry } from '@i-harness/core-agent'
import { createSessionCoordinator, createReadOnlySessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { createJsonlCommitCoordinator } from '../../session-persistence-jsonl/src/commit-coordinator.ts'
import { asSessionCoordinator } from '@i-harness/session-persistence/internal/commit-facade'
import { spawnChild } from '../src/child.ts'
import { createAgentTable } from '../src/agent-table.ts'
import { createJobRegistry } from '../src/jobs.ts'
import type { SpawnOptions } from '../src/child.ts'
import { captureHostChildInput, openHostChildBirth } from '../src/child/host-birth.ts'
import { fixtureGenerationFor, controlledModel } from './generation-fixture.ts'

const ref = { id: 'ctx_' + 'a'.repeat(64), workspaceId: 'w', sessionId: 'creator', callId: 'old', label: 'old', revision: 'b'.repeat(64), bytes: 1, originalBytes: 1, complete: true, expiresAt: 2_000_000_000_000 }
async function fixture(backendOptions?: Parameters<typeof createJsonlBackend>[1]) {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'host-birth-guard-'))
  const backend = createJsonlBackend(root, backendOptions)
  const coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const ctx = createContext()
  let models = 0
  const source = createSession()
  const options: SpawnOptions = {
    generationFactoryFor: fixtureGenerationFor,
    taskName: 'host', message: 'initial instruction', parentPath: 'root',
    parentCtx: ctx, parentRegistry: createToolRegistry(ctx), parentSession: source,
    childSessions: { coordinator, parentSessionId: 'parent' }, forkTurns: 'none',
    role: { name: 'probe', description: '', systemPrompt: 'probe', tools: [] },
    table: createAgentTable(), jobs: createJobRegistry(), agents: createAgentRegistry(),
    resolveModel: async () => ({ status: 'unconfigured', reason: 'unused' }),
    parentModel: controlledModel(async function* () { models++; throw Error('Guard control must not send') }),
  }
  return { root, backend, coordinator, source, options, models: () => models, async close() { await coordinator.close(); await ctx.scope.unmount() } }
}
const start = () => ({ wall: Date.now(), monotonic: performance.now() })

it.each(['jsonl', 'commit-log'] as const)('supports an actual target-only observation without accepting an empty existing-read on %s', async storage => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'host-target-observation-'))
  const coordinator = storage === 'jsonl'
    ? createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
    : asSessionCoordinator(createJsonlCommitCoordinator(root, { lock: { enabled: true, lockRoot: root } }))
  let reads = 0
  try {
    await expect(coordinator.withExistingSessionBindingObservation!({ sessionIds: [] }, async () => { reads++; return true })).rejects.toMatchObject({ reason: 'invalid' })
    expect(reads).toBe(0)
    const target = { version: 1 as const, operationId: 'target-only', targetSessionId: 'target', createdAt: '2026-11-01T00:00:00.000Z', requestDigest: 'a'.repeat(64) }
    expect(await coordinator.withSessionBindingObservation!({ existingSessionIds: [], target }, async observation => {
      observation.assertCurrent()
      expect(observation.binding('target')).toEqual({ kind: 'absent' })
      return true
    })).toBe(true)
    expect(await coordinator.list()).toEqual([])
  } finally { await coordinator.close() }
})

it.each(['before-issue', 'after-ack'] as const)('preserves original cancellation at actual initial IO %s', async cut => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let writes = 0
  const f = await fixture({ wrapOwnedBatch: original => async (...args) => {
    const initial = decodeFactBatch(args[3].bytes).events.some(event => event.type === 'agent/input/admitted')
    if (initial && cut === 'before-issue') { entered.resolve(); await release.promise }
    const outcome = await original(...args)
    if (initial && outcome.kind === 'committed') {
      writes++
      if (cut === 'after-ack') { entered.resolve(); await release.promise }
    }
    return outcome
  } })
  const controller = new AbortController()
  const reason = cut === 'before-issue' ? new Error('Original cancellation during birth') : false
  f.options.signal = controller.signal
  const spawning = spawnChild(f.options)
  const observed = spawning.then(value => ({ value }), error => ({ error }))
  let primary: { cause: unknown } | undefined
  try {
    await Promise.race([entered.promise, observed.then(result => { if ('error' in result) throw result.error; throw Error('Birth skipped its original IO boundary') })])
    controller.abort(reason)
    release.resolve()
    await expect(spawning).rejects.toBe(reason)
    expect(writes).toBe(cut === 'before-issue' ? 0 : 1)
    expect(f.models()).toBe(0)
    expect(f.options.table.entries().size).toBe(0)
  } catch (error) { primary = { cause: error }; throw error }
  finally {
    release.resolve()
    await observed
    try { await f.close() } catch (cleanup) {
      if (primary) throw new AggregateError([primary.cause, cleanup], 'Original cancelled birth and cleanup failed', { cause: primary.cause })
      throw cleanup
    }
  }
}, 20000)

it('refuses original cancellation before publishing a target', async () => {
  const f = await fixture(), controller = new AbortController(), reason = new Error('original cancelled request')
  try {
    f.options.signal = controller.signal
    const captured = captureHostChildInput(f.options)
    controller.abort(reason)
    await expect(openHostChildBirth(captured, start(), undefined)).rejects.toBe(reason)
    expect(await f.coordinator.list()).toEqual([])
    expect(f.models()).toBe(0)
  } finally { await f.close() }
})

it.each(['none', 0] as const)('selection %s does not read irrelevant unsupported source history or dependencies', async selection => {
  const f = await fixture()
  let reads = 0
  try {
    const source = f.source
    f.options.forkTurns = selection
    source.formatVersion = Number.MAX_SAFE_INTEGER
    Object.defineProperty(source, 'events', { get() { reads++; throw Error('Unselected historical payload read') } })
    const born = await openHostChildBirth(captureHostChildInput(f.options), start(), undefined)
    expect(reads).toBe(0)
    expect(born.document.view.events.filter(event => event.type === 'agent/input/admitted')).toHaveLength(1)
    await born.close()
    expect(f.models()).toBe(0)
  } finally { await f.close() }
})

it.each([['all', false], ['all', true], [1, false], [1, true]] as const)('qualifies only transferred legacy refs for selection %s (unsequenced=%s)', async (selection, unsequenced) => {
  const f = await fixture()
  try {
    const source = f.source
    append(source, { type: 'turn/start' })
    append(source, { type: 'user/message', text: 'older' })
    append(source, { type: 'context/result-ref', ref })
    append(source, { type: 'turn/end' })
    append(source, { type: 'turn/start' })
    append(source, { type: 'user/message', text: 'selected text' })
    append(source, { type: 'turn/end' })
    if (unsequenced) {
      source.events.splice(0, source.events.length,
        { type: 'turn/start' }, { type: 'user/message', text: 'older' },
        { type: 'context/result-ref', ref }, { type: 'turn/end' },
        { type: 'turn/start' }, { type: 'user/message', text: 'selected text' }, { type: 'turn/end' })
    }
    f.options.forkTurns = selection
    if (selection === 'all') {
      expect(() => captureHostChildInput(f.options)).toThrow('result-dependency transfer')
      expect(await f.coordinator.list()).toEqual([])
    } else {
      const born = await openHostChildBirth(captureHostChildInput(f.options), start(), undefined)
      expect(JSON.stringify(born.document.view.events)).toContain('selected text')
      expect(JSON.stringify(born.document.view.events)).not.toContain(ref.id)
      await born.close()
    }
    expect(f.models()).toBe(0)
  } finally { await f.close() }
})

it('refuses a real non-owning read facet before a target write', async () => {
  const f = await fixture()
  const read = createReadOnlySessionCoordinator(createJsonlBackend(f.root))
  try {
    // Deliberate negative: a real read facet cannot satisfy a writable host.
    f.options.childSessions!.coordinator = read as unknown as typeof f.coordinator
    await expect(openHostChildBirth(captureHostChildInput(f.options), start(), undefined)).rejects.toMatchObject({ code: 'FACT_OWNER_UNSUPPORTED' })
    expect(await f.coordinator.list()).toEqual([])
  } finally { await read.close(); await f.close() }
})

it('retains actual issued unknown completion and reconciles the same native frame during original close', async () => {
  let held = true, writes = 0
  const initial = (bytes: Uint8Array) => decodeFactBatch(bytes).events.some(event => event.type === 'agent/input/admitted')
  const f = await fixture({
    wrap(backend) {
      const confirm = backend.confirmBootstrapFrames!
      backend.confirmBootstrapFrames = async (...args) => {
        const result = await Reflect.apply(confirm, backend, args)
        return held && writes > 0 && result.kind === 'committed' ? { kind: 'unknown' } : result
      }
    },
    wrapOwnedBatch: original => async (...args) => {
      const result = await original(...args)
      if (initial(args[3].bytes) && result.kind === 'committed') {
        writes++
        if (held) return { kind: 'unknown', key: args[3].key }
      }
      return result
    },
    wrapOwnedReconcile: original => async (...args) => {
      const result = await original(...args)
      return held && writes > 0 && initial(args[3].bytes) && result.kind === 'committed' ? { kind: 'unknown', key: args[3].key } : result
    },
  })
  let primary: { cause: unknown } | undefined
  try {
    const failure = await openHostChildBirth(captureHostChildInput(f.options), start(), undefined).catch(error => error)
    expect(failure).toMatchObject({ code: 'FACT_RECOVERY_REQUIRED', outcome: { kind: 'blocked' } })
    expect(writes).toBe(1)
    expect(f.models()).toBe(0)
    await expect(f.coordinator.close()).rejects.toThrow()
    await expect(f.coordinator.close()).rejects.toThrow()
    expect(writes).toBe(1)
    held = false
    await f.coordinator.close()
    const cold = createSessionCoordinator(createJsonlBackend(f.root), { lock: { enabled: true } })
    try {
      const ids = await cold.list()
      expect(ids).toHaveLength(1)
      const view = (await cold.snapshot!(ids[0]!)).session
      expect(view.events.filter(event => event.type === 'agent/input/admitted')).toHaveLength(1)
      expect(view.events.filter(event => event.type === 'model/exchange-accepted')).toHaveLength(0)
      expect(writes).toBe(1)
    } finally { await cold.close() }
  } catch (error) {
    primary = { cause: error }
    throw error
  } finally {
    held = false
    try { await f.close() } catch (cleanup) {
      if (primary) throw new AggregateError([primary.cause, cleanup], 'Original unknown birth and cleanup failed', { cause: primary.cause })
      throw cleanup
    }
  }
}, 20000)

it.each([NaN, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid raw history selection %s before target IO', async selection => {
  const f = await fixture()
  try {
    f.options.forkTurns = selection
    expect(() => captureHostChildInput(f.options)).toThrow('forkTurns')
    expect(await f.coordinator.list()).toEqual([])
  } finally { await f.close() }
})

it('closes an original uncertain bootstrap frame only after native reconciliation proves it absent', async () => {
  let held = true, issued = 0
  let originalKey: import('@i-harness/core-session').BatchKey | undefined
  let originalBytes: Uint8Array | undefined
  const reconciled: Array<{ key: import('@i-harness/core-session').BatchKey; bytes: Uint8Array }> = []
  const initial = (bytes: Uint8Array) => decodeFactBatch(bytes).events.some(event => event.type === 'agent/input/admitted')
  const f = await fixture({
    wrapOwnedBatch: original => async (...args) => {
      if (!initial(args[3].bytes)) return original(...args)
      // The actual original issuer crosses its issue boundary, then this
      // constructor fault models failure before any frame bytes are written.
      args[1].beforeIssue()
      issued++
      originalKey = args[3].key
      originalBytes = Uint8Array.from(args[3].bytes)
      return { kind: 'unknown', key: args[3].key }
    },
    wrapOwnedReconcile: original => async (...args) => {
      const outcome = await original(...args)
      if (issued && initial(args[3].bytes)) {
        reconciled.push({ key: args[3].key, bytes: Uint8Array.from(args[3].bytes) })
        if (held && outcome.kind === 'absent') return { kind: 'unknown', key: args[3].key }
      }
      return outcome
    },
  })
  try {
    const failure = await openHostChildBirth(captureHostChildInput(f.options), start(), undefined).catch(error => error)
    expect(failure).toMatchObject({ code: 'FACT_RECOVERY_REQUIRED', outcome: { kind: 'blocked' } })
    expect(issued).toBe(1)
    await expect(f.coordinator.close()).rejects.toThrow()
    held = false
    await f.coordinator.close()
    expect(reconciled.length).toBeGreaterThan(0)
    for (const attempt of reconciled) {
      expect(attempt.key).toEqual(originalKey)
      expect(attempt.bytes).toEqual(originalBytes)
    }
    expect(issued).toBe(1)
    expect(f.models()).toBe(0)
    const cold = createSessionCoordinator(createJsonlBackend(f.root), { lock: { enabled: true } })
    try {
      const inspection = await cold.inspectBootstrap(failure.outcome.token.invocation)
      expect(inspection.kind).toBe('reserved')
    } finally { await cold.close() }
  } finally { held = false; await f.close() }
}, 20000)
