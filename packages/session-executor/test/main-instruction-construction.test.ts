import { beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InstructionEnvironment } from '../src/context/instructions/contracts.ts'
import { createSessionAssembly } from '../src/assembly.ts'
import { createInstructionEnvironment } from '../src/context/instructions/index.ts'
import { rmWorkspaceSync } from './helpers.ts'
import { runHeadless } from '../../../apps/cli/src/run.ts'
import { createSession, decodeFactBatch } from '@i-harness/core-session'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createSessionService } from '../src/service.ts'

const observed = vi.hoisted(() => ({ created: [] as { environment: InstructionEnvironment; closeCalls: number }[],
  leases: [] as { attempts: number; closed: boolean }[], failLeaseClose: false, cleanupFault: undefined as Error | undefined,
  inputs: [] as { close(): Promise<void>; closeCalls: number }[], failInputClose: false, inputFault: undefined as Error | undefined }))
vi.mock('../../../apps/cli/src/initial-input.ts', async original => {
  const api = await original<typeof import('../../../apps/cli/src/initial-input.ts')>()
  return { ...api, async openCliInput(...args: Parameters<typeof api.openCliInput>) {
    const input = await api.openCliInput(...args), close = input.close.bind(input), entry = { close, closeCalls: 0 }
    observed.inputs.push(entry)
    input.close = async () => { entry.closeCalls++; if (observed.failInputClose) throw observed.inputFault; await close() }
    return input
  } }
})
const barriers = vi.hoisted(() => ({ policyBeforeCodeMode: false }))
vi.mock('../src/lifecycle/result-store.ts', async original => {
  const api = await original<typeof import('../src/lifecycle/result-store.ts')>()
  return { ...api, async acquireAssemblyResultStore(...args: Parameters<typeof api.acquireAssemblyResultStore>) {
    const store = await api.acquireAssemblyResultStore(...args)
    // Precise existing construction await; the store and policy owner stay real.
    if (barriers.policyBeforeCodeMode) await observed.created[0]!.environment.policy.ready()
    return store
  } }
})
vi.mock('@i-harness/fs-watch', async original => {
  const api = await original<typeof import('@i-harness/fs-watch')>()
  return { ...api, createFsWatchService(...args: Parameters<typeof api.createFsWatchService>) {
    const watch = api.createFsWatchService(...args), acquire = watch.acquire.bind(watch)
    watch.acquire = options => {
      const lease = acquire(options), close = lease.close.bind(lease), entry = { attempts: 0, closed: false }
      observed.leases.push(entry)
      lease.close = async () => {
        entry.attempts++
        if (observed.failLeaseClose) throw observed.cleanupFault
        await close(); entry.closed = true
      }
      return lease
    }
    return watch
  } }
})
vi.mock('../src/context/instructions/index.ts', async original => {
  const api = await original<typeof import('../src/context/instructions/index.ts')>()
  return { ...api, createInstructionEnvironment(options: Parameters<typeof api.createInstructionEnvironment>[0]) {
    const environment = api.createInstructionEnvironment(options), close = environment.close.bind(environment)
    const entry = { environment, closeCalls: 0 }; observed.created.push(entry)
    // Observe and call through on the same real owner; no replacement host.
    environment.close = async () => { entry.closeCalls++; await close() }
    return environment
  } }
})
beforeEach(() => { observed.created = []; observed.leases = []; observed.failLeaseClose = false; observed.cleanupFault = undefined; barriers.policyBeforeCodeMode = false; observed.inputs = []; observed.failInputClose = false; observed.inputFault = undefined })

it('standalone selected-profile construction does not acquire an orphan environment before a throwing Code Mode getter', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-instruction-construction-')), workspace = join(root, 'workspace'), settingsPath = join(root, 'settings.json')
  await mkdir(workspace); await writeFile(settingsPath, JSON.stringify({ instructions: { enabled: true, maxBytes: 24000, globalSources: [] } }))
  const fault = Error('original standalone Code Mode getter fault')
  let getterCalls = 0, modelCalls = 0
  try {
    const result = await createSessionAssembly({ workspace, instructionSettingsPath: settingsPath,
      model: { async *stream() { modelCalls++; yield { type: 'end' as const } } },
      codeMode() { getterCalls++; throw fault },
    }).catch(error => error)
    expect(result).toBe(fault); expect(getterCalls).toBe(1); expect(modelCalls).toBe(0)
    const states = []
    for (const entry of observed.created) {
      await entry.environment.policy.ready().catch(() => {})
      states.push({ closeCalls: entry.closeCalls, state: entry.environment.policy.current() })
    }
    console.log('standalone-construction-owner', JSON.stringify({ created: observed.created.length, states, getterCalls, modelCalls }))
    expect(observed.created).toHaveLength(0)
  } finally {
    // The RED probe still drains every actual captured owner, so the test
    // itself never leaves the asynchronously initialized native watch alive.
    for (const entry of observed.created) await entry.environment.close()
    rmWorkspaceSync(root)
  }
})

it.each([false, true])('later construction failure drains only the internally owned environment (borrowed=%s)', async borrowed => {
  const root = await mkdtemp(join(tmpdir(), 'ih-instruction-mount-')), workspace = join(root, 'workspace'), settingsPath = join(root, 'settings.json')
  await mkdir(workspace); await writeFile(settingsPath, '{}')
  const fault = Error('original later construction fault')
  const outer = borrowed ? createInstructionEnvironment({ settingsPath }) : undefined
  let modelCalls = 0
  try {
    const result = await createSessionAssembly({ workspace, ...(outer ? { instructionEnvironment: outer } : { instructionSettingsPath: settingsPath }), codeMode: { mode: 'mixed' },
      model: { async *stream() { modelCalls++; yield { type: 'end' as const } } },
      codeModeFactory: () => ({ schemas: () => [], async ready() { await observed.created[0]!.environment.policy.ready(); throw fault }, async cancel() {}, async dispose() {} }),
    }).catch(error => error)
    expect(result).toBe(fault); expect(modelCalls).toBe(0); expect(observed.created).toHaveLength(1)
    const entry = observed.created[0]!
    expect(entry.closeCalls).toBe(borrowed ? 0 : 1)
    if (borrowed) { await expect(entry.environment.policy.ready()).resolves.toBeUndefined(); expect(observed.leases.every(lease => !lease.closed)).toBe(true) }
    else { await expect(entry.environment.policy.ready()).rejects.toThrow(); expect(observed.leases.every(lease => lease.closed)).toBe(true) }
  } finally { for (const entry of observed.created) await entry.environment.close(); rmWorkspaceSync(root) }
})

it('construction keeps the original fault and actual same-lease cleanup failure without replacing its owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-instruction-mount-close-')), workspace = join(root, 'workspace'), settingsPath = join(root, 'settings.json')
  await mkdir(workspace); await writeFile(settingsPath, '{}')
  const fault = Error('original mount fault'), cleanupFault = Error('original policy watch lease close fault')
  observed.cleanupFault = cleanupFault
  try {
    const result = await createSessionAssembly({ workspace, instructionSettingsPath: settingsPath, codeMode: { mode: 'mixed' },
      model: { async *stream() { throw Error('construction must never request the model') } },
      codeModeFactory: () => ({ schemas: () => [], async ready() { await observed.created[0]!.environment.policy.ready(); observed.failLeaseClose = true; throw fault }, async cancel() {}, async dispose() {} }),
    }).catch(error => error)
    const tree = (error: unknown): unknown[] => [error, ...(error instanceof AggregateError ? error.errors.flatMap(tree) : []), ...(error instanceof Error && error.cause ? tree(error.cause) : [])]
    expect(result).toBeInstanceOf(AggregateError); expect(result.cause).toBe(fault)
    expect(tree(result)).toContain(fault); expect(tree(result)).toContain(cleanupFault)
    expect(observed.created).toHaveLength(1); expect(observed.leases).toHaveLength(1)
    expect(observed.leases[0]!.closed).toBe(false)
    const original = observed.created[0]!
    expect(original.closeCalls).toBe(1)
    observed.failLeaseClose = false
    await original.environment.close()
    expect(original.closeCalls).toBe(2); expect(observed.created).toHaveLength(1)
    expect(observed.leases).toHaveLength(1); expect(observed.leases[0]).toMatchObject({ closed: true })
  } finally { observed.failLeaseClose = false; for (const entry of observed.created) await entry.environment.close(); rmWorkspaceSync(root) }
})

it.each([false, true])('headless failed construction respects its actual selected-profile owner (borrowed=%s)', async borrowed => {
  const root = await mkdtemp(join(tmpdir(), 'ih-instruction-headless-mount-')), workspace = join(root, 'workspace'), settingsPath = join(root, 'settings.json')
  await mkdir(workspace); await writeFile(settingsPath, '{}')
  const fault = Error('original headless Code Mode option fault'), previousHome = process.env.IH_CONFIG_DIR
  let getterCalls = 0, modelCalls = 0
  process.env.IH_CONFIG_DIR = root
  const outer = borrowed ? createInstructionEnvironment({ settingsPath }) : undefined
  try {
    const result = await runHeadless('construction only', { workspace, instructionSettingsPath: settingsPath, ...(outer ? { instructionEnvironment: outer } : {}),
      model: { async *stream() { modelCalls++; yield { type: 'end' as const } } },
      codeMode: { get mode(): never { getterCalls++; throw fault } },
    })
    expect(result).toMatchObject({ exitCode: 1, error: fault.message })
    expect(getterCalls).toBe(1); expect(modelCalls).toBe(0); expect(observed.created).toHaveLength(1)
    const entry = observed.created[0]!
    await entry.environment.policy.ready().catch(() => {})
    console.log('headless-construction-owner', JSON.stringify({ closeCalls: entry.closeCalls, state: entry.environment.policy.current(), modelCalls }))
    expect(entry.closeCalls).toBe(borrowed ? 0 : 1)
    if (borrowed) await expect(entry.environment.policy.ready()).resolves.toBeUndefined()
    else await expect(entry.environment.policy.ready()).rejects.toThrow()
  } finally {
    for (const entry of observed.created) await entry.environment.close()
    if (previousHome === undefined) delete process.env.IH_CONFIG_DIR
    else process.env.IH_CONFIG_DIR = previousHome
    rmWorkspaceSync(root)
  }
})

it('headless mount cleanup exposes the original failed lease and retries only that same cleanup handle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-instruction-headless-close-')), workspace = join(root, 'workspace'), settingsPath = join(root, 'settings.json')
  await mkdir(workspace); await writeFile(settingsPath, '{}')
  const fault = Error('original headless normalize fault'), cleanupFault = Error('original headless policy lease cleanup fault'), previousHome = process.env.IH_CONFIG_DIR
  const session = createSession()
  let modelCalls = 0, getterCalls = 0
  process.env.IH_CONFIG_DIR = root; barriers.policyBeforeCodeMode = true; observed.cleanupFault = cleanupFault
  try {
    const result = await runHeadless('no model execution', { workspace, session, instructionSettingsPath: settingsPath,
      model: { async *stream() { modelCalls++; yield { type: 'end' as const } } },
      codeMode: { get mode(): never { getterCalls++; observed.failLeaseClose = true; throw fault } },
    }).catch(error => error)
    const tree = (error: unknown): unknown[] => [error, ...(error instanceof AggregateError ? error.errors.flatMap(tree) : []), ...(error instanceof Error && error.cause ? tree(error.cause) : [])]
    expect(result).toMatchObject({ name: 'HeadlessCleanupError', retryCleanup: expect.any(Function) })
    expect(tree(result)).toContain(fault); expect(tree(result)).toContain(cleanupFault)
    expect([getterCalls, modelCalls, observed.created.length, observed.leases.length]).toEqual([1, 0, 1, 1])
    const entry = observed.created[0]!, eventCount = session.events.length
    expect(entry.closeCalls).toBe(1); expect(observed.leases[0]!.closed).toBe(false)
    observed.failLeaseClose = false
    await result.retryCleanup()
    expect(entry.closeCalls).toBe(2); expect(observed.leases[0]!.closed).toBe(true)
    expect([getterCalls, modelCalls, observed.created.length, observed.leases.length]).toEqual([1, 0, 1, 1])
    expect(session.events).toHaveLength(eventCount)
  } finally {
    barriers.policyBeforeCodeMode = false; observed.failLeaseClose = false
    for (const entry of observed.created) await entry.environment.close()
    if (previousHome === undefined) delete process.env.IH_CONFIG_DIR
    else process.env.IH_CONFIG_DIR = previousHome
    rmWorkspaceSync(root)
  }
})

it('a failed initial input close still permits safe environment cleanup and retries the original input only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-headless-input-close-')), workspace = join(root, 'workspace'), settingsPath = join(root, 'settings.json')
  await mkdir(workspace); await writeFile(settingsPath, '{}')
  const fault = Error('original headless mount fault'), inputFault = Error('original initial-input close fault'), previousHome = process.env.IH_CONFIG_DIR, session = createSession()
  let modelCalls = 0, getterCalls = 0
  observed.inputFault = inputFault; observed.failInputClose = true; process.env.IH_CONFIG_DIR = root
  try {
    const result = await runHeadless('no input replay', { workspace, session, instructionSettingsPath: settingsPath,
      model: { async *stream() { modelCalls++; yield { type: 'end' as const } } }, codeMode: { get mode(): never { getterCalls++; throw fault } },
    }).catch(error => error)
    const tree = (error: unknown): unknown[] => [error, ...(error instanceof AggregateError ? error.errors.flatMap(tree) : []), ...(error instanceof Error && error.cause ? tree(error.cause) : [])]
    expect(result).toMatchObject({ name: 'HeadlessCleanupError', retryCleanup: expect.any(Function) })
    expect(tree(result)).toContain(fault); expect(tree(result)).toContain(inputFault)
    expect(observed.created[0]!.closeCalls).toBe(1)
    await expect(observed.created[0]!.environment.policy.ready()).rejects.toThrow()
    const admitted = session.events.filter(event => event.type === 'agent/input/admitted').length
    const actions = session.events.filter(event => event.type === 'context/action' && event.op === 'open').length
    observed.failInputClose = false; await result.retryCleanup()
    expect(observed.inputs).toHaveLength(1); expect(observed.inputs[0]!.closeCalls).toBe(2)
    expect(session.events.filter(event => event.type === 'agent/input/admitted')).toHaveLength(admitted)
    expect(session.events.filter(event => event.type === 'context/action' && event.op === 'open')).toHaveLength(actions)
    expect([getterCalls, modelCalls, observed.created.length]).toEqual([1, 0, 1])
  } finally {
    observed.failInputClose = false; for (const input of observed.inputs) await input.close()
    for (const entry of observed.created) await entry.environment.close()
    if (previousHome === undefined) delete process.env.IH_CONFIG_DIR; else process.env.IH_CONFIG_DIR = previousHome
    rmWorkspaceSync(root)
  }
})

it('a real failed run-end frame preserves the mount error and still closes the owned environment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-headless-run-end-')), workspace = join(root, 'workspace'), settingsPath = join(root, 'settings.json')
  await mkdir(workspace); await writeFile(settingsPath, '{}')
  const backend = createJsonlBackend(join(root, 'sessions')), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } }), { id } = await coordinator.create()
  const append = backend.appendOwnedBatch!, fault = Error('original mount before run-end'), previousHome = process.env.IH_CONFIG_DIR
  let runEnds = 0, modelCalls = 0
  backend.appendOwnedBatch = (...args) => { if (decodeFactBatch(args[3].bytes).events.some(event => event.type === 'operator/run-end')) { runEnds++; return Promise.resolve({ kind: 'absent' as const, key: args[3].key }) }; return append(...args) }
  process.env.IH_CONFIG_DIR = root
  try {
    const result = await runHeadless('construction with original journal', { workspace, coordinator, sessionId: id, instructionSettingsPath: settingsPath,
      model: { async *stream() { modelCalls++; yield { type: 'end' as const } } }, codeMode: { get mode(): never { throw fault } },
    }).catch(error => error)
    expect(result).toBeInstanceOf(AggregateError); expect(result.cause).toBe(fault); expect(result.errors[0]).toBe(fault)
    expect(result.errors[1]).toMatchObject({ code: 'FACT_RECOVERY_REQUIRED', outcome: { kind: 'absent' } })
    expect([runEnds, modelCalls, observed.created.length, observed.created[0]!.closeCalls]).toEqual([1, 0, 1, 1])
    await expect(observed.created[0]!.environment.policy.ready()).rejects.toThrow()
  } finally {
    for (const entry of observed.created) await entry.environment.close(); await coordinator.close()
    if (previousHome === undefined) delete process.env.IH_CONFIG_DIR; else process.env.IH_CONFIG_DIR = previousHome
    rmWorkspaceSync(root)
  }
})

it('service failed assembly construction retains its outer owner until the original service close', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-service-construction-')), settingsPath = join(root, 'settings.json')
  await writeFile(settingsPath, '{}')
  const fault = Error('original service assembly getter fault')
  let modelCalls = 0
  const service = createSessionService({ workspace: root, instructionSettingsPath: settingsPath, model: { async *stream() { modelCalls++; yield { type: 'end' as const } } }, codeMode() { throw fault } })
  try {
    await expect(service.assemblyFor('failed')).rejects.toBe(fault)
    expect(observed.created).toHaveLength(1); expect(observed.created[0]!.closeCalls).toBe(0)
    await observed.created[0]!.environment.policy.ready()
    await service.close()
    expect(observed.created[0]!.closeCalls).toBe(1); expect(modelCalls).toBe(0)
    await expect(observed.created[0]!.environment.policy.ready()).rejects.toThrow()
  } finally { await service.close(); for (const entry of observed.created) await entry.environment.close(); rmWorkspaceSync(root) }
})
