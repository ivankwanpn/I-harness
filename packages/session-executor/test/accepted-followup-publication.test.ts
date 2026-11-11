import { expect, it, vi } from 'vitest'

const faults = vi.hoisted(() => ({
  target: '', phase: 'pending' as 'pending' | 'retained', point: 'before' as 'before' | 'after', failSave: false,
  unknownResult: false, saveFaults: 0, nativeSaves: 0, captures: 0, resultAttempts: 0,
  saveEntered: undefined as undefined | (() => void), resultEntered: undefined as undefined | (() => void),
  childGate: undefined as undefined | { entered(): void; release: Promise<void>; releaseForCleanup(): void },
  failure: Error('Original followup snapshot publication failed'),
  snapshots: [] as { value: unknown; encoded: string; failed: boolean }[],
}))
vi.mock('../../session-persistence-jsonl/src/backend/document-write.ts', async load => {
  const actual = await load<typeof import('../../session-persistence-jsonl/src/backend/document-write.ts')>()
  return { ...actual, async writeLegacyDocument(...args: Parameters<typeof actual.writeLegacyDocument>) {
    const [path, data] = args
    const state = data as { agentTable?: { path: string; lastInboxSeq?: number; result?: { kind: string } }[] }
    const selected = path === faults.target && state.agentTable?.some(row => row.path === 'root/helper' && row.lastInboxSeq !== undefined && row.result?.kind === faults.phase)
    if (path === faults.target && state.agentTable?.some(row => row.path === 'root/helper' && row.lastInboxSeq !== undefined)) {
      faults.snapshots.push({ value: data, encoded: JSON.stringify(data), failed: !!selected && faults.failSave })
    }
    if (selected && faults.failSave && faults.point === 'before') {
      faults.saveFaults++; faults.saveEntered?.(); throw faults.failure
    }
    await actual.writeLegacyDocument(...args)
    if (selected) faults.nativeSaves++
    if (selected && faults.failSave && faults.point === 'after') {
      faults.saveFaults++; faults.saveEntered?.(); throw faults.failure
    }
  } }
})
vi.mock('../src/lifecycle/task-result-retention.ts', async load => {
  const actual = await load<typeof import('../src/lifecycle/task-result-retention.ts')>()
  type Store = ReturnType<typeof actual.createTaskResultRetention>
  const wrap = (store: Store): Store => ({
    ...store,
    ...(store.forSource ? { async forSource(...args: Parameters<NonNullable<Store['forSource']>>) { return wrap(await store.forSource!(...args)) } } : {}),
    capture(...args: Parameters<Store['capture']>) {
      const capture = store.capture(...args)
      const followup = args[0].id.startsWith('subagent-')
      if (followup) faults.captures++
      return { async settle() {
        const outcome = await capture.settle()
        if (followup) {
          faults.resultAttempts++
          if (faults.unknownResult) { faults.resultEntered?.(); return { kind: 'recovery-required' as const } }
        }
        return outcome
      } }
    },
  })
  return { ...actual, createTaskResultRetention(...args: Parameters<typeof actual.createTaskResultRetention>) { return wrap(actual.createTaskResultRetention(...args)) } }
})

import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { createDurableSessionLoader, createSessionService, createUnmanagedTaskChildHost } from '../src/index.ts'
import { controlledModel } from './controlled-model.ts'
import { inspect } from 'node:util'

async function fixture() {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'followup-publication-'))
  Object.assign(faults, { target: join(root, 'parent.doc.jsonl'), failSave: false, unknownResult: false, saveFaults: 0, nativeSaves: 0, captures: 0, resultAttempts: 0, saveEntered: undefined, resultEntered: undefined, childGate: undefined, snapshots: [] })
  const coordinator = createSessionCoordinator(createJsonlBackend(root))
  await coordinator.create({ sessionId: 'parent' })
  const calls: { name: string; args: unknown }[] = []
  let childBodies = 0
  const model = controlledModel(async function* (request) {
    const call = request.messages.at(-1)?.role === 'user' ? calls.shift() : undefined
    if (call) yield { type: 'tool_call', call }
    else yield { type: 'text/chunk', text: 'parent complete' }
    yield { type: 'end' }
  })
  const child = controlledModel(async function* (request) {
    childBodies++
    if (childBodies > 1 && faults.childGate) {
      const gate = faults.childGate
      gate.entered()
      const aborted = Promise.withResolvers<never>()
      const stop = () => aborted.reject(request.signal?.reason ?? Error('Original child aborted'))
      request.signal?.addEventListener('abort', stop, { once: true })
      try {
        if (request.signal?.aborted) stop()
        await Promise.race([gate.release, aborted.promise])
      } finally { request.signal?.removeEventListener('abort', stop) }
    }
    yield { type: 'text/chunk', text: 'original child result ' + childBodies }; yield { type: 'end' }
  })
  const service = createSessionService({ workspace: root, coordinator, sessionFor: createDurableSessionLoader(coordinator), model,
    approveAll: true, sandbox: 'danger-full-access', codeMode: { mode: 'off' },
    prepareTaskChild: createUnmanagedTaskChildHost({ coordinator, policy: 'unmanaged' }),
    allowSubagentModelSelection: true, roleSelectionFor: () => ({ provider: 'fixture', model: 'child' }),
    resolveRoleModel: async () => ({ status: 'ready', binding: { client: child, contextWindow: 100000 } }),
  })
  const assembly = await service.assemblyFor('parent')
  const execute = async (name: string, args: unknown) => {
    const before = assembly.session.events.length
    calls.push({ name, args })
    await service.submit('parent', 'Perform original fixture operation', new AbortController().signal)
    const result = assembly.session.events.slice(before).find(event => event.type === 'tool/result' && event.name === name)
    expect(result).toMatchObject({ envelope: { execution: { outcome: 'succeeded' } } })
  }
  await execute('spawn_agent', { task_name: 'helper', agent_type: 'explore', message: 'initial', fork_turns: 'none', background: false })
  return { coordinator, service, assembly, execute, bodies: () => childBodies, async close() {
    faults.failSave = false; faults.unknownResult = false
    faults.childGate?.releaseForCleanup()
    const results = []
    for (const close of [() => service.close(), () => coordinator.close()]) {
      try { await close() } catch (error) { results.push(error) }
    }
    await rm(root, { recursive: true, force: true })
    if (results.length) throw new AggregateError(results, 'Original followup fixture cleanup failed')
  } }
}

async function withFixture(run: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const f = await fixture()
  let primary: { error: unknown } | undefined, cleanup: { error: unknown } | undefined
  try { await run(f) } catch (error) { primary = { error } }
  try { await f.close() } catch (error) { cleanup = { error } }
  if (primary || cleanup) {
    const errors = [...(primary ? [primary.error] : []), ...(cleanup ? [cleanup.error] : [])]
    console.error('Original followup publication failure', inspect(errors, { depth: 12 }))
    if (errors.length === 1) throw errors[0]
    throw new AggregateError(errors, 'Original followup assertion and cleanup failed', { cause: primary?.error })
  }
}

it.each(['before', 'after'] as const)('repairs the same captured pending snapshot after actual %s native publication failure without repeating the child', async point => {
  await withFixture(async f => {
    const entered = Promise.withResolvers<void>()
    faults.point = point; faults.phase = 'pending'; faults.failSave = true; faults.saveEntered = entered.resolve
    const executing = f.execute('followup_task', { target: 'root/helper', message: 'followup' })
    await Promise.race([entered.promise, executing.then(() => entered.promise)])
    await executing; expect(faults.saveFaults).toBeGreaterThan(0)
    faults.failSave = false
    await f.service.close()
    const state = await f.coordinator.getDocument('parent') as { agentTable: { path: string; result?: { kind: string }; lastInboxSeq?: number }[] }
    expect(state.agentTable.find(row => row.path === 'root/helper')).toMatchObject({ result: { kind: 'retained' }, lastInboxSeq: expect.any(Number) })
    const failed = faults.snapshots.find(snapshot => snapshot.failed)!
    const repaired = faults.snapshots.find(snapshot => !snapshot.failed && snapshot.value === failed.value)
    expect(repaired?.encoded).toBe(failed.encoded)
    // The final snapshot is newer than the failed pending snapshot. Its
    // native write follows the original retry, without rereading mutable state.
    const final = faults.snapshots.findIndex(snapshot => !snapshot.failed && snapshot.encoded.includes('"kind":"retained"'))
    expect(final).toBeGreaterThan(faults.snapshots.indexOf(repaired!))
    expect(f.bodies()).toBe(2); expect(faults.captures).toBe(1)
  })
}, 30_000)

it('retains an original unknown result ACK through failed close and final publication repair without body replay', async () => {
  await withFixture(async f => {
    const entered = Promise.withResolvers<void>()
    faults.unknownResult = true; faults.resultEntered = entered.resolve
    const executing = f.execute('followup_task', { target: 'root/helper', message: 'followup' })
    await Promise.race([entered.promise, executing.then(() => entered.promise)])
    await executing
    await expect(f.service.close()).rejects.toThrow()
    expect(f.bodies()).toBe(2); expect(faults.captures).toBe(1)
    faults.unknownResult = false
    await f.service.close()
    const state = await f.coordinator.getDocument('parent') as { agentTable: { path: string; result?: { kind: string } }[] }
    expect(state.agentTable.find(row => row.path === 'root/helper')).toMatchObject({ result: { kind: 'retained' } })
    expect(f.bodies()).toBe(2); expect(faults.captures).toBe(1)
  })
}, 30_000)

it('closes a known canceled original followup without retaining its historical drive rejection as cleanup debt', async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  try {
    await withFixture(async f => {
      faults.childGate = { entered: entered.resolve, release: release.promise, releaseForCleanup: release.resolve }
      const executing = f.execute('followup_task', { target: 'root/helper', message: 'stop this original followup' })
      await Promise.race([entered.promise, executing.then(() => entered.promise)])
      await executing
      await f.service.close()
      await f.service.close()
      const state = await f.coordinator.getDocument('parent') as { agentTable: { path: string; result?: unknown }[] }
      expect(state.agentTable.find(row => row.path === 'root/helper')).toMatchObject({
        result: { kind: 'retained', envelope: { execution: { outcome: 'canceled', dispatch: 'dispatched' } } },
      })
      expect(f.bodies()).toBe(2); expect(faults.captures).toBe(1)
    })
  } finally { release.resolve() }
}, 30_000)
