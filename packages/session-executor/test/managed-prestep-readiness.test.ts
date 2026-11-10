import { afterEach, expect, it, vi } from 'vitest'
type CloseControl = { fail: boolean; error: Error }
type Gate = { entered: ReturnType<typeof Promise.withResolvers<void>>; release: ReturnType<typeof Promise.withResolvers<void>> }
const probe = vi.hoisted(() => ({ nextClose: undefined as Gate | undefined, nextCloseCheck: undefined as CloseControl | undefined, nextReenter: undefined as (() => Promise<void>) | undefined, opens: 0, nextRead: undefined as Gate | undefined, afterReady: undefined as (() => Promise<void>) | undefined, waits: 0, secondWait: undefined as (() => void) | undefined, rejected: undefined as ((error: unknown) => void) | undefined }))
vi.mock('../../session-persistence/src/execution-internal.ts', async load => {
  const original = await load<typeof import('../../session-persistence/src/execution-internal.ts')>()
  return { ...original, associateExecutionDependencies(backend: object, open: Parameters<typeof original.associateExecutionDependencies>[1]) {
    original.associateExecutionDependencies(backend, (...args) => {
      const scope = open(...args), held = probe.nextClose, reading = probe.nextRead, closeCheck = probe.nextCloseCheck
      let reenter = probe.nextReenter
      probe.nextReenter = undefined
      probe.opens++
      probe.nextCloseCheck = undefined
      probe.nextClose = undefined
      probe.nextRead = undefined
      return Object.freeze({ assertCurrent: scope.assertCurrent.bind(scope), async readEvent(ordinal: number) { if (reading) { reading.entered.resolve(); await reading.release.promise }; return scope.readEvent(ordinal) }, async close() {
        if (held) { held.entered.resolve(); await held.release.promise }
        if (reenter) { const callback = reenter; reenter = undefined; await callback() }
        if (closeCheck?.fail) throw closeCheck.error
        await scope.close()
      } })
    })
  } }
})
vi.mock('@i-harness/core-session/internal/execution', async load => {
  const original = await load<typeof import('@i-harness/core-session/internal/execution')>()
  return { ...original, getManagedExecutionAdmissionWait(...args: Parameters<typeof original.getManagedExecutionAdmissionWait>) {
    const wait = original.getManagedExecutionAdmissionWait(...args)
    if (!wait) return wait
    probe.waits++
    if (probe.waits === 2) probe.secondWait?.()
    const after = probe.afterReady
    probe.afterReady = undefined
    const observed = wait.catch(error => { probe.rejected?.(error); throw error })
    return after ? observed.then(after) : observed
  } }
})
import { mkdtemp, rm } from 'node:fs/promises'
import { join, relative, isAbsolute, sep } from 'node:path'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { composeJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createOwnedMetadataFold } from '../src/lifecycle/owned-metadata-fold.ts'
import { createSessionService } from '../src/service.ts'
import { controlledModel } from './controlled-model.ts'
import { onExecutionEvent } from '@i-harness/core-plugin'
import { prepareOriginalManagedRuntime, type OriginalManagedRuntime } from '../src/host-managed-execution.ts'
import { originalManagedExecution } from '../../session-persistence/src/coordinator/managed-document.ts'
import * as documents from '../../session-persistence/src/coordinator/managed-document.ts'
import { getManagedExecutionAdmissionWait, assertManagedActionLifetimeCurrent, settleManagedExecutionDependencies } from '@i-harness/core-session/internal/execution'

afterEach(() => { probe.nextReenter = undefined; probe.opens = 0; probe.nextCloseCheck = undefined; probe.nextRead = undefined; probe.nextClose = undefined; probe.afterReady = undefined; probe.waits = 0; probe.secondWait = undefined; probe.rejected = undefined })
const gate = (): Gate => ({ entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() })
type PreparedArchive = Awaited<ReturnType<OriginalManagedRuntime['execution']['prepare']>>
type HydrationFixture = { runtime: OriginalManagedRuntime; service: ReturnType<typeof createSessionService>; action: ReturnType<OriginalManagedRuntime['execution']['owner']['beginAction']>; requests(): number }

async function withHydrationFixture(run: (fixture: HydrationFixture) => Promise<void>) {
  const evidenceRoot = process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!
  const root = await mkdtemp(join(evidenceRoot, 'hydration-lifetime-'))
  const coordinator = composeJsonlTaskTransitionCoordinator(createJsonlBackend(root), { lock: { enabled: true }, originalExecutionFoldFactory: createOwnedMetadataFold }, taskDocumentStorageContract)
  await coordinator.create({ sessionId: 'main' })
  let requests = 0, action: HydrationFixture['action'] | undefined
  const service = createSessionService({ workspace: root, coordinator, contextWindow: 4096, maxOutputTokens: 128,
    model: controlledModel(async function* () { requests++; yield { type: 'text/chunk', text: 'existing committed output' }; yield { type: 'end' } }),
    managedRuntime: { systemPrompt: 'system', tools: [] },
  })
  try {
    await service.submit('main', 'existing committed conversation', new AbortController().signal)
    const runtime = (await prepareOriginalManagedRuntime(service, 'main'))!
    action = runtime.execution.owner.beginAction()
    await action.facts.metadata.admit({ type: 'plan/mode', mode: 'on' })
    await run({ runtime, service, action, requests: () => requests })
  } finally {
    action?.finish()
    await service.close(); await coordinator.close()
    const tail = relative(evidenceRoot, root)
    if (!tail || tail === '..' || tail.startsWith(`..${sep}`) || isAbsolute(tail)) throw Error('Unsafe fixture cleanup')
    await rm(root, { recursive: true, force: true })
  }
}

it.each(['ready', 'abort', 'unknown'] as const)('joins genuine post-prestep dependency work before physical issue: %s', async end => {
  const evidenceRoot = process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!
  const root = await mkdtemp(join(evidenceRoot, 'prestep-ready-'))
  const coordinator = composeJsonlTaskTransitionCoordinator(createJsonlBackend(root), { lock: { enabled: true }, originalExecutionFoldFactory: createOwnedMetadataFold }, taskDocumentStorageContract)
  await coordinator.create({ sessionId: 'main' })
  const factory = vi.spyOn(documents, 'createManagedDocument')
  const first = gate(), second = gate(), rechecked = Promise.withResolvers<void>(), rejected = Promise.withResolvers<unknown>()
  probe.secondWait = rechecked.resolve
  probe.rejected = rejected.resolve
  let requests = 0, hooks = 0, readFirst: Promise<unknown> | undefined, readSecond: Promise<unknown> | undefined
  const service = createSessionService({ workspace: root, coordinator, contextWindow: 4096, maxOutputTokens: 128,
    model: controlledModel(async function* () { requests++; yield { type: 'text/chunk', text: 'done' }; yield { type: 'end' } }),
    managedRuntime: { systemPrompt: 'system', tools: [], async mountRegistry(original) {
      onExecutionEvent(original.ctx, 'agent/pre-step', async () => {
        hooks++
        probe.afterReady = async () => {
          probe.nextClose = second
          readSecond = original.execution.observe().inbox.admitted('seed')
          void readSecond.catch(() => {})
          await second.entered.promise
        }
        probe.nextClose = first
        readFirst = original.execution.observe().inbox.admitted('seed')
        void readFirst.catch(() => {})
        await first.entered.promise
      })
    } },
  })
  const input = await service.managedInputFor!('main')
  await input!.inbox.admit({ inputId: 'seed', text: 'archived input record', delivery: 'queue', intent: 'user', provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'desktop.input' } })
  await input!.inbox.cancel('seed', 'fixture seed only')
  const runtime = await prepareOriginalManagedRuntime(service, 'main')
  const ownership = factory.mock.calls.at(-1)![4]
  const core = originalManagedExecution(runtime!.execution.owner as Parameters<typeof originalManagedExecution>[0], ownership).core
  const turn = service.submit('main', 'real foreground input', new AbortController().signal)
  const outcome = turn.then(() => ({ kind: 'done' as const }), error => ({ kind: 'failed' as const, error }))
  try {
    await Promise.race([first.entered.promise, outcome.then(value => { throw Error('Turn ended before original read: ' + value.kind) })])
    expect(requests).toBe(0)
    first.release.resolve()
    await Promise.race([rechecked.promise, outcome.then(value => { throw Error('Turn did not recheck readiness: ' + value.kind) })])
    expect(requests).toBe(0); expect(hooks).toBe(1)
    if (end === 'abort') service.cancelRunning!('main')
    else if (end === 'unknown') core.readinessChanged(true)
    if (end !== 'ready') {
      const error = await rejected.promise
      if (end === 'unknown') expect(error).toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
      expect(requests).toBe(0)
    }
    second.release.resolve()
    if (end === 'unknown') core.readinessChanged(false)
    if (end !== 'ready') {
      const result = await outcome
      expect(result.kind).toBe('failed')
      if (result.kind === 'failed' && end === 'unknown') expect(result.error).toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
      expect(requests).toBe(0)
    }
    if (end === 'ready') { await turn; expect(requests).toBe(1); expect(hooks).toBe(1) }
  } finally {
    first.release.resolve(); second.release.resolve(); core.readinessChanged(false)
    await Promise.allSettled([outcome, readFirst, readSecond])
    await service.close(); await coordinator.close(); factory.mockRestore()
    const tail = relative(evidenceRoot, root)
    if (!tail || tail === '..' || tail.startsWith(`..${sep}`) || isAbsolute(tail)) throw Error('Unsafe fixture cleanup')
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

it('keeps original conversation hydration visible to the same writer admission owner', async () => {
  const evidenceRoot = process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!
  const root = await mkdtemp(join(evidenceRoot, 'hydration-ready-'))
  const coordinator = composeJsonlTaskTransitionCoordinator(createJsonlBackend(root), { lock: { enabled: true }, originalExecutionFoldFactory: createOwnedMetadataFold }, taskDocumentStorageContract)
  await coordinator.create({ sessionId: 'main' })
  const service = createSessionService({ workspace: root, coordinator, contextWindow: 4096, maxOutputTokens: 128,
    model: controlledModel(async function* () { yield { type: 'text/chunk', text: 'existing committed output' }; yield { type: 'end' } }),
    managedRuntime: { systemPrompt: 'system', tools: [] },
  })
  const held = gate()
  let archive: PreparedArchive | undefined
  try {
    await service.submit('main', 'existing committed conversation', new AbortController().signal)
    const runtime = (await prepareOriginalManagedRuntime(service, 'main'))!
    const action = runtime.execution.owner.beginAction()
    await action.facts.metadata.admit({ type: 'plan/mode', mode: 'on' })
    probe.nextRead = held
    const preparing = runtime.execution.prepare().then(value => { archive = value; return true }, () => false)
    await held.entered.promise
    const waiting = getManagedExecutionAdmissionWait(runtime.domain, action, action.signal)
    const wasBusy = waiting instanceof Promise
    const writing = (await service.managedInputFor!('main'))!.inbox.admit({ inputId: 'next', text: 'next accepted work', delivery: 'queue', intent: 'user', provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'desktop.input' } })
    void writing.catch(() => {})
    // On the broken path, force the actual invisible-read overlap rather than
    // depending on scheduler timing. Correct admission holds this write.
    if (!wasBusy) await writing
    held.release.resolve()
    const prepared = await preparing
    await writing
    await waiting
    expect(wasBusy).toBe(true)
    expect(prepared).toBe(true)
    action.finish()
  } finally {
    held.release.resolve()
    await archive?.settle()
    await service.close(); await coordinator.close()
    const tail = relative(evidenceRoot, root)
    if (!tail || tail === '..' || tail.startsWith(`..${sep}`) || isAbsolute(tail)) throw Error('Unsafe fixture cleanup')
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

it('shares one original hydration while keeping concurrent and cached archive leases independent', async () => {
  await withHydrationFixture(async ({ runtime }) => {
    const held = gate(), opened = probe.opens
    probe.nextRead = held
    const first = runtime.execution.prepare(), second = runtime.execution.prepare()
    void first.catch(() => {}); void second.catch(() => {})
    try {
      await held.entered.promise
      expect(probe.opens).toBe(opened + 1)
      held.release.resolve()
      const [a, b] = await Promise.all([first, second])
      expect(a).not.toBe(b)
      await a.settle()
      expect(() => a.assertCurrent()).toThrow()
      expect(() => b.assertCurrent()).not.toThrow()
      const cached = await runtime.execution.prepare()
      expect(probe.opens).toBe(opened + 1)
      await b.settle(); expect(() => cached.assertCurrent()).not.toThrow(); await cached.settle()
    } finally { held.release.resolve(); await Promise.allSettled([first, second]) }
  })
}, 30_000)

it('retains the original hydration close debt until exact explicit cleanup succeeds', async () => {
  await withHydrationFixture(async ({ runtime, requests }) => {
    const control = { fail: true, error: Error('Original hydration native close not acknowledged') }
    probe.nextCloseCheck = control
    try {
      await expect(runtime.execution.prepare()).rejects.toBe(control.error)
      expect(() => runtime.execution.observe()).toThrow()
      expect(() => runtime.domain.assertCurrent()).toThrow()
      const opened = probe.opens
      control.fail = false
      await settleManagedExecutionDependencies(runtime.domain)
      const archive = await runtime.execution.prepare()
      expect(() => archive.assertCurrent()).not.toThrow()
      expect(probe.opens).toBe(opened)
      expect(requests()).toBe(1)
      await archive.settle()
    } finally { control.fail = false; await settleManagedExecutionDependencies(runtime.domain) }
  })
}, 30_000)

it.each(['ack', 'failure'] as const)('joins active hydration before serving a cache lease while native close is held: %s', async end => {
  await withHydrationFixture(async ({ runtime }) => {
    const held = gate(), control = { fail: end === 'failure', error: Error('Original held hydration close failed') }
    probe.nextClose = held; probe.nextCloseCheck = control
    const observe = (flight: Promise<PreparedArchive>) => flight.then(archive => ({ archive }), error => ({ error }))
    const first = observe(runtime.execution.prepare())
    let second: ReturnType<typeof observe> | undefined
    const leases: PreparedArchive[] = []
    try {
      await held.entered.promise
      let settled = false
      second = observe(runtime.execution.prepare()).then(result => { settled = true; return result })
      await Promise.resolve()
      await Promise.resolve()
      const servedBeforeAcknowledgment = settled
      held.release.resolve()
      const results = await Promise.all([first, second])
      for (const result of results) if ('archive' in result) leases.push(result.archive)
      expect(servedBeforeAcknowledgment).toBe(false)
      expect(results.every(result => 'archive' in result)).toBe(end === 'ack')
      if (end === 'failure') expect(results.every(result => 'error' in result && result.error === control.error)).toBe(true)
    } finally {
      held.release.resolve(); control.fail = false
      await Promise.allSettled([first, second])
      for (const lease of leases) await lease.settle()
      await settleManagedExecutionDependencies(runtime.domain)
    }
  })
}, 30_000)

it.each(['abort', 'close'] as const)('refuses model admission after %s while original hydration is held', async end => {
  await withHydrationFixture(async ({ runtime, service, action, requests }) => {
    const held = gate()
    probe.nextRead = held
    const preparing = runtime.execution.prepare()
    void preparing.catch(() => {})
    let closing: Promise<void> | undefined, archive: PreparedArchive | undefined
    try {
      await held.entered.promise
      const wait = getManagedExecutionAdmissionWait(runtime.domain, action, action.signal)!
      const refused = wait.then(() => false, () => true)
      if (end === 'abort') action.stop()
      else { closing = service.closeSession('main'); void closing.catch(() => {}) }
      expect(await refused).toBe(true)
      held.release.resolve()
      if (end === 'abort') { archive = await preparing; expect(() => archive!.assertCurrent()).not.toThrow() }
      else { await expect(preparing).rejects.toThrow(); await closing; await expect(runtime.execution.prepare()).rejects.toThrow() }
      expect(requests()).toBe(1)
    } finally { held.release.resolve(); await preparing.catch(() => {}); await archive?.settle(); await closing }
  })
}, 30_000)

it('refuses a constructor-owned native close callback joining its own hydration without blocking cleanup', async () => {
  await withHydrationFixture(async ({ runtime }) => {
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    let outcome: 'pending' | 'refused' | 'lease' = 'pending', nested: Promise<void> | undefined
    probe.nextReenter = async () => {
      nested = Promise.resolve().then(() => runtime.execution.prepare()).then(async archive => { outcome = 'lease'; await archive.settle() }, () => { outcome = 'refused' })
      entered.resolve()
      // The explicit release only breaks the demonstrated cycle on a broken
      // implementation; no timeout or synthetic acknowledgment is involved.
      await Promise.race([nested, release.promise])
    }
    const outer = runtime.execution.prepare()
    void outer.catch(() => {})
    let archive: PreparedArchive | undefined
    try {
      await entered.promise
      await new Promise<void>(resolve => setImmediate(resolve))
      const blockedOnItself = outcome === 'pending'
      release.resolve()
      archive = await outer
      await nested
      expect(blockedOnItself).toBe(false)
      expect(outcome).toBe('refused')
      expect(() => archive!.assertCurrent()).not.toThrow()
    } finally { release.resolve(); await outer.catch(() => {}); await nested; await archive?.settle() }
  })
}, 30_000)

it.each(['commit', 'discard'] as const)('keeps an accepted staged write busy before original issuance: %s', async end => {
  const evidenceRoot = process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!
  const root = await mkdtemp(join(evidenceRoot, 'staged-write-ready-'))
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let hold = false
  const backend = createJsonlBackend(root, {
    wrapOwnedBatch(original) {
      return async (...args) => {
        if (hold) {
          entered.resolve()
          await release.promise
          if (end === 'discard') throw Error('Original pre-issuance refusal')
        }
        return original(...args)
      }
    },
  })
  const coordinator = composeJsonlTaskTransitionCoordinator(backend, { lock: { enabled: true }, originalExecutionFoldFactory: createOwnedMetadataFold }, taskDocumentStorageContract)
  await coordinator.create({ sessionId: 'main' })
  const service = createSessionService({ workspace: root, coordinator, contextWindow: 4096, maxOutputTokens: 128,
    model: controlledModel(async function* () { yield { type: 'end' } }),
    managedRuntime: { systemPrompt: 'system', tools: [] },
  })
  const input = await service.managedInputFor!('main')
  const runtime = await prepareOriginalManagedRuntime(service, 'main')
  const action = runtime!.execution.owner.beginAction()
  hold = true
  const writing = input!.inbox.admit({ inputId: 'held', text: 'accepted staged write', delivery: 'queue', intent: 'user', provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'desktop.input' } })
  const disposition = writing.then(() => 'committed' as const, () => 'refused' as const)
  try {
    await entered.promise
    expect(() => runtime!.domain.assertCurrent()).toThrow()
    expect(() => runtime!.execution.observe().generations()).not.toThrow()
    expect(() => assertManagedActionLifetimeCurrent(runtime!.domain, action)).not.toThrow()
    expect(() => assertManagedActionLifetimeCurrent(runtime!.domain, { ...action })).toThrow('Original same-domain action')
    const waiting = getManagedExecutionAdmissionWait(runtime!.domain, action, action.signal)
    let advanced = false
    const joined = waiting?.then(() => { advanced = true })
    await Promise.resolve()
    const wasBusy = waiting instanceof Promise
    const advancedWhileHeld = advanced
    hold = false
    release.resolve()
    const result = await disposition
    await joined
    expect(wasBusy).toBe(true)
    expect(advancedWhileHeld).toBe(false)
    expect(result).toBe(end === 'commit' ? 'committed' : 'refused')
    expect(runtime!.execution.observe().inbox.pending().some(item => item.inputId === 'held')).toBe(end === 'commit')
    expect(getManagedExecutionAdmissionWait(runtime!.domain, action, action.signal)).toBeUndefined()
    action.stop()
    expect(() => assertManagedActionLifetimeCurrent(runtime!.domain, action)).toThrow()
  } finally {
    hold = false
    release.resolve()
    await writing.catch(() => {})
    action.stop()
    await service.close(); await coordinator.close()
    const tail = relative(evidenceRoot, root)
    if (!tail || tail === '..' || tail.startsWith(`..${sep}`) || isAbsolute(tail)) throw Error('Unsafe fixture cleanup')
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
