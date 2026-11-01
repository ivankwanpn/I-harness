import { mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createLoopbackProvider } from '../../core-agent/test/helpers/provider-loopback.ts'
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts'
import { createSessionService, createDurableSessionLoader } from '../src/index.ts'

const probe = vi.hoisted(() => ({
  root: '', armed: false, fail: false, cause: undefined as unknown,
  entered: undefined as (() => void) | undefined, gate: undefined as Promise<void> | undefined,
  updates: 0, mount: undefined as import('../../subagent/src/index.ts').RegisterSubagentResult | undefined,
}))
function originalMount(): import('../../subagent/src/index.ts').RegisterSubagentResult | undefined { return probe.mount }
vi.mock('../../shell/src/discovery/windows.ts', () => ({ bashAvailable: () => true, resolveBashExe: () => 'controlled-bash', resolvePwshExe: () => 'controlled-pwsh', powerShellExecutableAvailable: () => true }))
vi.mock('../../subagent/src/index.ts', async original => {
  const actual = await original<typeof import('../../subagent/src/index.ts')>()
  return { ...actual, registerSubagent(...args: Parameters<typeof actual.registerSubagent>) {
    const mounted = actual.registerSubagent(...args)
    probe.mount = mounted
    return mounted
  } }
})
vi.mock('../src/plugin-capabilities.ts', async original => {
  const actual = await original<typeof import('../src/plugin-capabilities.ts')>()
  return { ...actual, createPluginCapabilities(...args: Parameters<typeof actual.createPluginCapabilities>) {
    const capabilities = actual.createPluginCapabilities(...args)
    return { ...capabilities, update(...input: Parameters<typeof capabilities.update>) {
      if (input[0].pluginAgents?.some(role => role.name === 'startup-probe')) probe.updates++
      return capabilities.update(...input)
    } }
  } }
})
vi.mock('../../session-persistence-jsonl/src/backend/task-document-observation.ts', async original => {
  const actual = await original<typeof import('../../session-persistence-jsonl/src/backend/task-document-observation.ts')>()
  return { ...actual, createTaskDocumentObservation(...args: Parameters<typeof actual.createTaskDocumentObservation>) {
    const observation = actual.createTaskDocumentObservation(...args)
    if (!probe.armed || resolve(args[0]) !== probe.root || args[2].key !== 'task-parent') return observation
    return { ...observation, async observe() {
      probe.entered?.()
      await probe.gate
      const result = await observation.observe()
      if (probe.fail) throw probe.cause
      return result
    }, confirm: observation.confirm.bind(observation), stageWrite: observation.stageWrite.bind(observation),
    stageInitialize: observation.stageInitialize.bind(observation), settleResources: observation.settleResources.bind(observation) }
  } }
})

it.each([false, true])('actual plugin role startup joins original registry readiness (failed: %s)', async failed => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'plugin-ready-'))
  const store = join(root, 'sessions'), coordinator = createJsonlTaskTransitionCoordinator(store, { lock: { enabled: true } }, taskDocumentStorageContract)
  await coordinator.create({ sessionId: 'parent' })
  await coordinator.openManagedDocument('parent')
  const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>(), original = new Error('Original startup task observation failed')
  probe.root = resolve(store); probe.armed = true; probe.fail = failed; probe.cause = original; probe.entered = entered.resolve; probe.gate = gate.promise; probe.updates = 0; probe.mount = undefined
  const provider = await createLoopbackProvider('/v1/chat/completions', [])
  const service = createSessionService({ workspace: root, coordinator, sessionFor: createDurableSessionLoader(coordinator),
    model: createOpenAICompatibleClient({ apiKey: 'loopback', model: 'fixture', baseUrl: provider.baseUrl }), modelPolicy: 'test-mock',
    sandbox: 'danger-full-access', approveAll: true, codeMode: { mode: 'off' }, contextWindow: 100000,
    agentShell: () => ({ id: 'controlled', label: 'controlled', command: 'controlled', dialect: 'posix' }),
    pluginAgents: [{ name: 'startup-probe', description: 'Original startup role', systemPrompt: 'Return an observation', tools: [] }],
  })
  let settled = false
  const mounting = service.assemblyFor('parent')
  void mounting.then(() => { settled = true }, () => { settled = true })
  try {
    await Promise.race([entered.promise, mounting.catch(() => undefined)])
    expect(probe.updates).toBe(0)
    expect(settled).toBe(false)
    expect(originalMount()?.roles.get('startup-probe')).toBeUndefined()
    expect(provider.requests).toHaveLength(0)
    gate.resolve()
    if (failed) {
      const failure = await mounting.then(() => undefined, cause => cause)
      expect(failure === original || failure?.cause === original).toBe(true)
      expect(probe.updates).toBe(0)
      expect(originalMount()?.roles.get('startup-probe')).toBeUndefined()
      // The original failed ready remains rejected; cleanup must not manufacture
      // readiness or a role. The same original document resources are joined.
      await expect(probe.mount!.ready).rejects.toBe(original)
    } else {
      const assembly = await mounting
      expect(probe.updates).toBe(1)
      expect(probe.mount!.roles.get('startup-probe')).toMatchObject({ name: 'startup-probe' })
      expect(assembly.subagentState().roles.some(role => role.name === 'startup-probe')).toBe(true)
    }
    expect(provider.requests).toHaveLength(0)
  } finally {
    gate.resolve(); probe.armed = false
    await mounting.catch(() => undefined)
    const closed = await service.close().then(() => undefined, cause => cause)
    // A failed initialization remains the original cleanup rejection. The
    // document owner must nevertheless release its own task/read resources.
    if (!failed && closed) throw closed
    if (failed && closed) {
      const causes = (error: unknown): unknown[] => error instanceof AggregateError ? error.errors.flatMap(causes) : [error]
      expect(causes(closed).length).toBeGreaterThan(0)
      expect(causes(closed).every(cause => cause === original)).toBe(true)
    }
    await coordinator.close()
    await provider.close()
  }
}, 15000)
