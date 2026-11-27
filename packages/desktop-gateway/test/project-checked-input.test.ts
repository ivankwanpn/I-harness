import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import * as executor from '@i-harness/session-executor'
import type { SessionCoordinator } from '@i-harness/session-persistence'
import { INVALID_PARAMS, isRpcSuccess, type RpcMessage } from '@i-harness/sdk'
import { createSdkServer } from '@i-harness/sdk/server'
import { fromJSONL } from '@i-harness/core-session'
import type { LLMRequest, LLMStreamEvent } from '@i-harness/llm-seam'
import { controlledModel } from '../../session-executor/test/controlled-model.ts'
import { originalManagedExecutionFor } from '../../session-executor/src/host-managed-execution.ts'
import * as projectScope from '../src/project-scope.ts'
import { createDesktopHost } from '../src/host.ts'
import { createDesktopRouter, createGatewayWrite } from '../src/router.ts'
import type { AgentProcessesView } from '../src/agent-processes.ts'
import type { PendingInteraction } from '../src/interaction.ts'
import type { DesktopHandlers } from '../src/types.ts'

const processCaptures = vi.hoisted(() => new Map<string, { entered(): void; release: Promise<void> }[]>())
vi.mock('../../session-persistence-jsonl/src/backend/process-read.ts', async original => {
  const real = await original<typeof import('../../session-persistence-jsonl/src/backend/process-read.ts')>()
  return { ...real, createJsonlProcessReadCapability(...args: Parameters<typeof real.createJsonlProcessReadCapability>) {
    const capability = real.createJsonlProcessReadCapability(...args)
    return { ...capability, async capture(id: string, keys: readonly string[]) {
      const original = await capability.capture(id, keys), hold = processCaptures.get(id)?.shift()
      if (hold) { hold.entered(); await hold.release }
      return original
    } }
  } }
})

function holdProcessCapture(id: string) {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const readers = processCaptures.get(id) ?? []
  readers.push({ entered: entered.resolve, release: release.promise })
  processCaptures.set(id, readers)
  return { entered: entered.promise, release: release.resolve }
}

type FixtureToolCall = Extract<LLMStreamEvent, { type: 'tool_call' }>['call']
async function fixture(beforeReply?: (request: LLMRequest) => Promise<void>, tools?: () => readonly FixtureToolCall[]) {
  const root = await mkdtemp(join(tmpdir(), 'ih-project-checked-input-'))
  const workspace = join(root, 'workspace'), other = join(root, 'other'), sessionDir = join(root, 'sessions')
  await Promise.all([mkdir(workspace), mkdir(other)])
  const settingsPath = join(root, 'settings.json'), credentialsPath = join(root, 'credentials.json')
  const shell = process.platform === 'win32' ? 'pwsh' : 'bash'
  await writeFile(settingsPath, JSON.stringify({ autoTitle: false, sandboxMode: tools ? 'danger-full-access' : 'read-only', codeMode: { mode: 'off' },
    ...(tools ? { approvalMode: 'full-access', agentShell: shell } : {}),
    instructions: { enabled: true }, compaction: { auto: false }, llm: { providers: { fixture: { protocol: 'openai-completions', baseURL: 'http://127.0.0.1:1',
      apiKeyEnv: 'IH_PROJECT_CHECK_FIXTURE', models: [{ id: 'fixture', contextWindow: 32000 }] } },
    defaultModel: { provider: 'fixture', model: 'fixture' } } }))
  await writeFile(credentialsPath, JSON.stringify({ refs: { IH_PROJECT_CHECK_FIXTURE: 'fixture-only' } }))

  let coordinator: SessionCoordinator | undefined, service: executor.SessionService | undefined
  const makeProjectScope = projectScope.createProjectScopeBroker, makeService = executor.createSessionService
  const scopeFactory = vi.spyOn(projectScope, 'createProjectScopeBroker').mockImplementation((store, ...rest) => {
    coordinator = store
    return makeProjectScope(store, ...rest)
  })
  const serviceFactory = vi.spyOn(executor, 'createSessionService').mockImplementation(options => service = makeService(options))
  const frames: RpcMessage[] = []
  const produceReply = vi.fn(async function* (request: LLMRequest) {
    await beforeReply?.(request)
    request.signal?.throwIfAborted()
    const calls = tools?.() ?? []
    for (const call of calls) yield { type: 'tool_call' as const, call }
    if (!calls.length) yield { type: 'text/chunk' as const, text: 'fixture answer' }
    yield { type: 'end' as const }
  })
  let host: Awaited<ReturnType<typeof createDesktopHost>> | undefined
  async function close() {
    try { await host?.close() }
    finally { scopeFactory.mockRestore(); serviceFactory.mockRestore(); await rm(root, { recursive: true, force: true }) }
  }
  try {
    host = await createDesktopHost({ workspace, sessionDir, settingsPath, credentialsPath, sessionStore: 'jsonl',
      experimentalUsageObservations: false, onWrite: frame => frames.push(frame),
      buildProviderClient: (profile, model) => controlledModel(produceReply, { modelId: model ?? profile.defaultModel,
        providerId: profile.name, executionIdentity: profile.executionIdentity }) })
    if (!coordinator || !service) throw new Error('Missing real host owners')
    let serial = 0
    const call = async (method: string, params: unknown = {}) => {
      const id = ++serial
      await host!.handleLine(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
      const reply = frames.findLast(frame => 'id' in frame && frame.id === id)
      if (!reply) throw Error(`Missing reply for ${method}`)
      return reply
    }
    const succeed = async (method: string, params?: unknown) => {
      const result = await call(method, params)
      if (!isRpcSuccess(result)) throw Error(JSON.stringify(result))
      return result.result
    }
    const saved = (id: string) => readFile(join(sessionDir, `${id}.jsonl`))
    const finished = async (id: string, ordinal = 1) => {
      const terminal = await vi.waitFor(() => {
        const reply = frames.filter(frame => {
          if (!('method' in frame) || frame.method !== 'session/status') return false
          const { sessionId, status } = frame.params as { sessionId: string; status: string }
          return sessionId === id && (status === 'completed' || status === 'error')
        })[ordinal - 1]
        expect(reply).toBeDefined()
        return reply
      }, { timeout: 20_000 })
      expect(terminal).toMatchObject({ params: { status: 'completed' } })
    }
    const idle = () => vi.waitFor(() => expect(host?.hasActiveWork?.()).toBe(false), { timeout: 20_000 })
    return { workspace, other, coordinator, service, produceReply, call, succeed, saved, finished, idle, frames, close }
  } catch (error) { await close(); throw error }
}

const submit = (sessionId: string, clientToken = 'checked-input-token') => ({ sessionId, clientToken, text: 'fixture input', delivery: 'queue' })

it('ignores a late Stop for A while B owns a live card, then stops B without dropping queued C', async () => {
  const aStarted = Promise.withResolvers<void>(), finishA = Promise.withResolvers<void>()
  let calls = 0
  const f = await fixture(async () => {
    if (++calls === 1) { aStarted.resolve(); await finishA.promise }
  }, () => calls === 2 ? [{
    id: 'question-for-b', name: 'ask_user_input', args: { question: 'B is still the current input' },
  }] : [])
  try {
    const { capabilities } = await f.succeed('initialize') as { capabilities: Record<string, string[]> }
    expect(capabilities['desktop-input']).toContain('stop-running')
    const { sessionId } = await f.succeed('session/create') as { sessionId: string }
    const push = async (text: string) => (await f.succeed('desktop/session/input/submit', {
      ...submit(sessionId, 'scoped-stop-fixture-' + text), text,
    }) as { inputId: string }).inputId
    const read = async () => fromJSONL((await f.saved(sessionId)).toString()).events
    const cards = async () => await f.succeed('desktop/interaction/pending', { sessionId }) as PendingInteraction[]
    const stop = (inputId: string) => f.succeed('desktop/session/input/stop', { sessionId, inputId })

    const a = await push('A')
    await aStarted.promise
    const fromA = () => stop(a)
    const b = await push('B')
    finishA.resolve()
    const card = await vi.waitFor(async () => {
      const pending = await cards()
      expect(pending).toHaveLength(1)
      return pending[0]!
    }, { timeout: 15000 })
    expect(card).toMatchObject({ kind: 'question' })
    const c = await push('C')
    expect(f.service.queue(sessionId)).toMatchObject([{ id: b, state: 'running' }, { id: c, state: 'queued' }])
    const before = await f.saved(sessionId)

    expect(await fromA()).toEqual({ cancelled: false, reason: 'stale-input' })
    expect(await stop(c)).toEqual({ cancelled: false, reason: 'stale-input' })
    expect(await cards()).toEqual([card])
    expect(await f.saved(sessionId)).toEqual(before)
    expect(f.service.queue(sessionId)).toMatchObject([{ id: b, state: 'running' }, { id: c, state: 'queued' }])

    expect(await stop(b)).toEqual({ cancelled: true })
    expect(await cards()).toEqual([])
    await f.idle()
    const saved = await read()
    const promoted = saved.filter(event => event.type === 'agent/input/promoted').map(event => event.inputId)
    expect(promoted).toEqual([a, b, c])
    expect(saved.filter(event => event.type === 'agent/input/cancelled' && event.inputId === c)).toEqual([])
    expect(saved.filter(event => event.type === 'assistant/message' && event.text === 'fixture answer')).toHaveLength(2)
    expect(saved.filter(event => event.type === 'agent/delivery-generation' && event.op === 'close')).toHaveLength(1)
    expect(calls).toBe(3)
  } finally { finishA.resolve(); await f.close() }
}, 60000)

it('announces a promoted private turn as running while its provider is held and reports durable Stop', async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), aborted = Promise.withResolvers<void>()
  const f = await fixture(async request => {
    if (!request.signal) throw new Error('The controlled provider needs the original abort signal')
    request.signal.addEventListener('abort', () => aborted.resolve(), { once: true })
    entered.resolve()
    await release.promise
  })
  let cancelling: Promise<unknown> | undefined
  try {
    await f.succeed('initialize')
    const { sessionId } = await f.succeed('session/create') as { sessionId: string }
    const read = async () => fromJSONL((await f.saved(sessionId)).toString()).events
    const state = () => f.frames.flatMap(frame => {
      if (!('method' in frame) || frame.method !== 'session/execution-state') return []
      const value = frame.params as { sessionId: string; running: boolean; queued: number; revision: number }
      return value.sessionId === sessionId ? [value] : []
    }).at(-1)

    expect(await f.succeed('desktop/session/input/submit', submit(sessionId, 'checked-input-hold-stop'))).toMatchObject({ accepted: true })
    await entered.promise
    const execution = originalManagedExecutionFor(f.service, sessionId)
    expect(execution).toBeDefined()
    expect(Object.hasOwn(execution!.owner, 'view')).toBe(false)
    expect((await read()).filter(event => event.type === 'agent/input/promoted')).toHaveLength(1)
    const active = state()
    expect(active).toMatchObject({ running: true, queued: 0 })

    cancelling = f.succeed('session/cancel', { sessionId })
    await aborted.promise
    release.resolve()
    expect(await cancelling).toMatchObject({ cancelled: true })

    await vi.waitFor(async () => {
      const events = await read()
      expect(events.filter(event => event.type === 'turn/end')).toHaveLength(1)
      expect(events.filter(event => event.type === 'assistant/message')).toHaveLength(0)
      expect(state()).toMatchObject({ running: false, queued: 0, revision: expect.any(Number) })
      expect(state()!.revision).toBeGreaterThan(active!.revision)
    }, { timeout: 20_000 })
    expect(f.produceReply).toHaveBeenCalledOnce()
    expect(Object.hasOwn(execution!.owner, 'view')).toBe(false)
  } finally { release.resolve(); await cancelling?.catch(() => {}); await f.close() }
}, 45_000)

it('reads Processes during and after a private turn without opening a compatibility assembly', async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const f = await fixture(async () => {
    entered.resolve()
    await release.promise
  })
  try {
    await f.succeed('initialize')
    const { sessionId } = await f.succeed('session/create') as { sessionId: string }
    const { sessionId: coldId } = await f.succeed('session/create') as { sessionId: string }
    expect(await f.succeed('desktop/session/input/submit', submit(sessionId, 'private-process-read'))).toMatchObject({ accepted: true })
    await entered.promise
    const execution = originalManagedExecutionFor(f.service, sessionId)
    expect(execution).toBeDefined()

    const read = (id: string) => f.succeed('desktop/session/processes/read', { sessionId: id })
    const privateView = { sessionId, live: true, terminals: [], jobs: [] }
    expect(await read(sessionId)).toEqual(privateView)
    expect(await read(coldId)).toEqual({ sessionId: coldId, live: false, terminals: [], jobs: [] })
    expect(await f.call('desktop/session/processes/control', { sessionId, command: { action: 'close', id: 'missing-pty' } })).toMatchObject({
      error: { message: 'Terminal has no live process owner in this session' },
    })
    release.resolve()
    await f.finished(sessionId)
    await f.idle()
    expect(await read(sessionId)).toEqual(privateView)
    expect(f.service.liveAssembly(sessionId)).toBeUndefined()
    expect(f.service.liveAssembly(coldId)).toBeUndefined()
    expect(Object.hasOwn(execution!.owner, 'view')).toBe(false)
    expect(originalManagedExecutionFor(f.service, sessionId)).toBe(execution)
  } finally { release.resolve(); await f.close() }
}, 45_000)

it('speculative warm joins one admitted cold Processes list without delaying other sessions or joining a later poll', async () => {
  const f = await fixture(), id = 'cold-list', other = 'independent'
  const first = holdProcessCapture(id), later = holdProcessCapture(id)
  const warmSession = f.service.warmSession
  if (!warmSession) throw Error('Missing original warm operation')
  const service = f.service as typeof f.service & { warmSession: typeof warmSession }
  const warm = vi.spyOn(service, 'warmSession')
  const flights: Promise<unknown>[] = []
  try {
    await f.succeed('initialize')
    await f.coordinator.create({ sessionId: id })
    await f.coordinator.create({ sessionId: other })
    const reading = f.succeed('desktop/session/processes/read', { sessionId: id })
    flights.push(reading); void reading.catch(() => {})
    await first.entered
    const warming = f.succeed('session/warm', { sessionId: id })
    flights.push(warming); void warming.catch(() => {})
    const polling = f.call('desktop/session/processes/read', { sessionId: id })
    flights.push(polling); void polling.catch(() => {})
    await later.entered

    expect(await f.succeed('session/warm', { sessionId: other })).toEqual({ ready: false, deferred: true })
    expect(warm.mock.calls).toEqual([[other]])
    expect(f.service.pendingAssemblyMount(id)).toBeUndefined()
    first.release()
    expect(await reading).toEqual({ sessionId: id, live: false, jobs: [], terminals: [] })
    expect(await warming).toEqual({ ready: false, deferred: true })
    expect(warm.mock.calls).toEqual([[other], [id]])
    expect(f.service.liveAssembly(id)).toBeUndefined()
    expect(originalManagedExecutionFor(f.service, id)).toBeUndefined()
    later.release()
    expect(isRpcSuccess(await polling)).toBe(true)
    expect(f.produceReply).not.toHaveBeenCalled()
  } finally {
    first.release(); later.release()
    await Promise.allSettled(flights)
    warm.mockRestore(); processCaptures.delete(id); await f.close()
  }
}, 45_000)

it('same-session user input proceeds during the cold list, and a refused read releases speculative warm', async () => {
  const f = await fixture(), id = 'prompt-during-cold-list'
  const held = holdProcessCapture(id), flights: Promise<unknown>[] = []
  try {
    await f.succeed('initialize')
    await f.coordinator.create({ sessionId: id })
    const reading = f.call('desktop/session/processes/read', { sessionId: id })
    flights.push(reading); void reading.catch(() => {})
    await held.entered
    const warming = f.succeed('session/warm', { sessionId: id })
    flights.push(warming); void warming.catch(() => {})
    expect(await f.succeed('desktop/session/input/submit', submit(id))).toMatchObject({ accepted: true })
    await f.finished(id)
    const execution = originalManagedExecutionFor(f.service, id)
    expect(execution).toBeDefined()
    expect(f.service.liveAssembly(id)).toBeUndefined()

    held.release()
    expect(isRpcSuccess(await reading)).toBe(false)
    expect(await warming).toEqual({ ready: true })
    expect(originalManagedExecutionFor(f.service, id)).toBe(execution)
    expect(f.service.liveAssembly(id)).toBeUndefined()
    expect(f.produceReply).toHaveBeenCalledOnce()
  } finally {
    held.release()
    await Promise.allSettled(flights)
    processCaptures.delete(id); await f.close()
  }
}, 45_000)

it('defers a cold warm so the first explicit compaction can use the original Session assembly', async () => {
  const f = await fixture(), id = 'first-explicit-compaction'
  try {
    await f.succeed('initialize')
    await f.coordinator.create({ sessionId: id })
    const before = await f.saved(id)
    expect(await f.succeed('session/warm', { sessionId: id })).toEqual({ ready: false, deferred: true })
    expect(await f.saved(id)).toEqual(before)
    expect(originalManagedExecutionFor(f.service, id)).toBeUndefined()
    expect(f.service.liveAssembly(id)).toBeUndefined()
    expect(f.produceReply).not.toHaveBeenCalled()
    expect(await f.succeed('desktop/session/compact', { sessionId: id })).toMatchObject({ outcome: expect.any(String) })
    const assembly = f.service.liveAssembly(id)
    expect(assembly).toBeDefined()
    expect(await f.succeed('session/warm', { sessionId: id })).toEqual({ ready: true })
    expect(await f.succeed('desktop/session/input/submit', submit(id))).toMatchObject({ accepted: true })
    await f.finished(id)
    expect(f.service.liveAssembly(id)).toBe(assembly)
    expect(originalManagedExecutionFor(f.service, id)).toBeUndefined()
  } finally { await f.close() }
}, 45_000)

it('cancels only the selected live native job through the original private owner', async () => {
  let calls: FixtureToolCall[] = []
  const f = await fixture(undefined, () => calls.splice(0))
  const id = 'private-process-control'
  try {
    await f.succeed('initialize')
    await f.coordinator.create({ sessionId: id })
    await f.coordinator.create({ sessionId: 'cold-other' })
    const script = join(f.workspace, 'job-fixture.cjs')
    await writeFile(script, 'console.log("fixture job " + process.argv[2]);setInterval(()=>{},1000);setTimeout(()=>process.exit(99),45000)')
    const quote = (value: string) => process.platform === 'win32'
      ? "'" + value.replaceAll("'", "''") + "'"
      : "'" + value.replaceAll("'", "'\\''") + "'"
    const command = `${process.platform === 'win32' ? '& ' : ''}${quote(process.execPath)} ${quote(script)}`
    calls = ['first', 'second'].map(label => ({
      id: 'process-launch-' + label, name: process.platform === 'win32' ? 'pwsh' : 'bash', args: { command: command + ' ' + label, background: true },
    }))
    expect(await f.succeed('session/warm', { sessionId: id })).toEqual({ ready: false, deferred: true })
    expect(await f.succeed('desktop/session/input/submit', submit(id))).toMatchObject({ accepted: true })
    await f.finished(id)
    const execution = originalManagedExecutionFor(f.service, id)
    expect(execution).toBeDefined()
    expect(f.service.liveAssembly(id)).toBeUndefined()
    const list = async () => (await f.succeed('desktop/session/processes/read', { sessionId: id }) as AgentProcessesView).jobs
    const listed = await vi.waitFor(async () => {
      const running = (await list()).filter(job => job.kind === 'shell' && job.status === 'running')
      expect(running).toHaveLength(2)
      expect(running.every(job => job.live && job.canCancel && !!job.nativeJob)).toBe(true)
      return running
    }, { timeout: 15_000 })
    const [first, second] = listed
    if (!first?.nativeJob || !second?.nativeJob) throw Error('Missing original native jobs')
    const cancel = (job: typeof first) => ({
      action: 'job/cancel', id: job.jobId, backend: 'shell',
      instanceId: job.nativeJob!.instanceId, sourceId: job.nativeJob!.sourceId,
    })
    expect(await f.call('desktop/session/processes/control', {
      sessionId: 'cold-other', command: cancel(first),
    })).toMatchObject({ error: { message: expect.stringContaining('No live process owner') } })
    expect(await f.call('desktop/session/processes/control', {
      sessionId: id, command: { ...cancel(first), sourceId: 'stale-source' },
    })).toMatchObject({ error: { message: expect.stringContaining('Native job instance changed') } })
    expect(await f.succeed('desktop/session/processes/control', { sessionId: id, command: cancel(first) }))
      .toEqual({ outcome: 'cancellation-requested' })
    await vi.waitFor(async () => {
      const jobs = await list()
      expect(jobs.find(job => job.jobId === first.jobId)).toMatchObject({ status: 'killed', canCancel: false })
      expect(jobs.find(job => job.jobId === second.jobId)).toMatchObject({ status: 'running', canCancel: true })
      const events = fromJSONL((await f.saved(id)).toString()).events
      expect(events.filter(event => event.type === 'exec/end' && event.instanceId === first.nativeJob!.instanceId)).toHaveLength(1)
      expect(() => execution!.observe().assertCurrent()).not.toThrow()
    }, { timeout: 15_000 })
    expect(await f.call('desktop/session/processes/control', {
      sessionId: id, command: cancel(first),
    })).toMatchObject({ error: { message: expect.stringContaining('not live or cancellable') } })
    expect(await f.succeed('desktop/session/processes/control', { sessionId: id, command: cancel(second) }))
      .toEqual({ outcome: 'cancellation-requested' })
    await f.idle()
    expect(originalManagedExecutionFor(f.service, id)).toBe(execution)
    expect(f.service.liveAssembly(id)).toBeUndefined()
  } finally { await f.close() }
}, 90_000)

it('lists and controls only original managed PTY output and close through the public process routes', async () => {
  let calls: FixtureToolCall[] = []
  const f = await fixture(undefined, () => calls.splice(0))
  const id = 'private-pty', other = 'unrelated-pty-owner'
  try {
    await f.succeed('initialize')
    await f.coordinator.create({ sessionId: id })
    await f.coordinator.create({ sessionId: other })
    const script = join(f.workspace, 'pty-fixture.cjs')
    await writeFile(script, 'console.log("fixture PTY " + process.argv[2]);setInterval(()=>{},1000);setTimeout(()=>process.exit(99),45000)')
    calls = ['closable', 'revoked'].map(label => ({
      id: 'pty-' + label, name: label === 'closable' ? 'terminal_open' : 'process_spawn',
      args: { command: process.execPath, args: [script, label] },
    }))
    const list = async () => (await f.succeed('desktop/session/processes/read', { sessionId: id }) as AgentProcessesView).terminals
    expect(await f.succeed('session/warm', { sessionId: id })).toEqual({ ready: false, deferred: true })
    expect(await list()).toEqual([])
    expect(await f.succeed('desktop/session/input/submit', submit(id))).toMatchObject({ accepted: true })
    await f.finished(id)
    expect(f.service.liveAssembly(id)).toBeUndefined()
    const events = fromJSONL((await f.saved(id)).toString()).events
    const terminalId = (label: string): string => {
      const result = events.find(event => event.type === 'tool/result' && event.callId === 'pty-' + label)
      if (result?.type !== 'tool/result' || result.envelope?.retention.kind !== 'inline') throw Error('Missing original PTY launch result')
      const output = result.envelope.retention.value as { id?: unknown }
      if (typeof output.id !== 'string') throw Error('PTY launch did not return an original handle: ' + JSON.stringify(output))
      return output.id
    }
    const first = terminalId('closable'), second = terminalId('revoked')
    const control = (sessionId: string, command: object) => f.call('desktop/session/processes/control', { sessionId, command })
    await vi.waitFor(async () => {
      const rows = await list()
      for (const idOfTerminal of [first, second]) expect(rows).toContainEqual(expect.objectContaining({
        id: idOfTerminal, ownerSessionId: id, live: true, canControl: false, canClose: true, status: 'running',
      }))
    }, { timeout: 15_000 })
    await vi.waitFor(async () => {
      expect(await f.succeed('desktop/session/processes/control', { sessionId: id, command: { action: 'read', id: first } }))
        .toMatchObject({ data: expect.stringContaining('fixture PTY closable'), nextOffset: expect.any(Number), status: 'running' })
    }, { timeout: 15_000 })
    expect(await f.succeed('desktop/session/input/submit', submit(other))).toMatchObject({ accepted: true })
    await f.finished(other)
    expect(originalManagedExecutionFor(f.service, other)).toBeDefined()
    for (const action of ['read', 'close']) {
      expect(await control(other, { action, id: first })).toMatchObject({ error: { message: expect.stringMatching(/owner|terminal/i) } })
    }
    expect(await control(id, { action: 'send', id: first, data: 'fixture unsolicited input' }))
      .toMatchObject({ error: { message: expect.stringContaining('unavailable for this private runtime') } })
    expect(await f.succeed('desktop/session/processes/control', { sessionId: id, command: { action: 'close', id: first } }))
      .toMatchObject({ id: first, ownerSessionId: id, status: 'exited' })
    expect((await list()).some(row => row.id === first && row.live)).toBe(false)
    expect((await list()).find(row => row.id === second)).toMatchObject({ canClose: true, status: 'running' })
    expect(await control(id, { action: 'close', id: first })).toMatchObject({ error: { message: expect.stringMatching(/owner|terminal/i) } })
    expect(await f.succeed('desktop/agent-settings/configure', { sandboxMode: 'read-only', approvalMode: 'dangerous' }))
      .toMatchObject({ effective: { sandboxMode: 'read-only' } })
    await vi.waitFor(async () => {
      const row = (await list()).find(row => row.id === second)
      expect(row?.canClose).toBeUndefined()
      expect(row?.status).not.toBe('running')
    }, { timeout: 15_000 })
    expect(await control(id, { action: 'send', id: second, data: 'fixture input after revocation' })).toMatchObject({ error: { message: expect.any(String) } })
    await f.service.closeSession(id)
    expect(await control(id, { action: 'read', id: second })).toMatchObject({ error: { message: expect.stringContaining('No live process owner') } })
  } finally { await f.close() }
}, 90_000)

it('checks the original project root once before attaching public input and preserves durable retries', async () => {
  const f = await fixture()
  try {
    expect(await f.succeed('initialize')).toMatchObject({ capabilities: { 'desktop-input': ['1', 'project-checked', 'stop-running'] } })
    await f.coordinator.create({ sessionId: 'visible' })
    await f.coordinator.create({ sessionId: 'review', origin: 'approval-review' })
    await f.coordinator.create({ sessionId: 'legacy' })
    await f.succeed('desktop/project/configure', { project: { id: 'p', name: 'Project', roots: [f.workspace], primaryRoot: f.workspace } })
    await f.succeed('desktop/session/project/bind', { sessionId: 'visible', projectId: 'p' })

    const visits: string[] = []
    const method = f.service.managedInputFor
    if (typeof method !== 'function') throw new Error('Missing managed input preparation')
    const service = f.service as typeof f.service & { managedInputFor: typeof method }
    const readProfile = f.coordinator.profile.bind(f.coordinator), prepareInput = method.bind(service)
    const profile = vi.spyOn(f.coordinator, 'profile').mockImplementation(async id => {
      if (id === 'visible') visits.push('profile')
      return readProfile(id)
    })
    const attach = vi.spyOn(service, 'managedInputFor').mockImplementation((id, options) => {
      if (id === 'visible') visits.push('attach')
      return prepareInput(id, options)
    })
    try {
      const before = await f.saved('review')
      expect(await f.call('desktop/session/input/submit', submit('review'))).toMatchObject({ error: { code: INVALID_PARAMS } })
      expect(attach).not.toHaveBeenCalled()
      expect(await f.saved('review')).toEqual(before)
      expect(f.produceReply).not.toHaveBeenCalled()

      const first = await f.succeed('desktop/session/input/submit', submit('visible'))
      expect(first).toMatchObject({ accepted: true, inputId: expect.any(String), delivery: 'queue' })
      const preparation = visits.indexOf('attach')
      expect(preparation).toBeGreaterThanOrEqual(0)
      expect(visits.slice(0, preparation)).toEqual(['profile'])
      await f.finished('visible')
      expect(await f.succeed('desktop/session/input/submit', submit('visible'))).toEqual(first)
      const saved = fromJSONL((await f.saved('visible')).toString()).events
      expect(saved.filter(event => event.type === 'agent/input/admitted')).toHaveLength(1)
      expect(saved.filter(event => event.type === 'assistant/message' && event.text === 'fixture answer')).toHaveLength(1)
      expect(f.produceReply).toHaveBeenCalledOnce()

      expect(await f.succeed('session/prompt', { sessionId: 'legacy', prompt: 'ordinary legacy prompt' })).toMatchObject({ ok: true })
      expect(f.produceReply).toHaveBeenCalledTimes(2)
    } finally { profile.mockRestore(); attach.mockRestore() }
  } finally { await f.close() }
}, 45_000)

it('blocks input during a project move and uses the destination instructions after the move', async () => {
  const f = await fixture()
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const originRule = 'ORIGIN_PROJECT_INSTRUCTION_SENTINEL', destinationRule = 'DESTINATION_PROJECT_INSTRUCTION_SENTINEL'
  let moving: Promise<unknown> | undefined
  try {
    await Promise.all([writeFile(join(f.workspace, 'AGENTS.md'), originRule), writeFile(join(f.other, 'AGENTS.md'), destinationRule)])
    await f.succeed('initialize')
    await f.coordinator.create({ sessionId: 'moving' })
    for (const [id, folder] of [['p', f.workspace], ['q', f.other]] as const) {
      await f.succeed('desktop/project/configure', { project: { id, name: id, roots: [folder], primaryRoot: folder } })
    }
    await f.succeed('desktop/session/project/bind', { sessionId: 'moving', projectId: 'p' })
    await f.succeed('desktop/session/input/submit', { ...submit('moving', 'before-move-input'), text: 'first fixture input' })
    await f.finished('moving')
    await f.idle()
    expect(f.produceReply).toHaveBeenCalledOnce()
    const initialRequest = f.produceReply.mock.calls[0]![0]
    expect(JSON.stringify([initialRequest.systemPrompt, initialRequest.messages])).toContain(originRule)
    const before = await f.saved('moving')
    const adopt = f.coordinator.adoptOwnership.bind(f.coordinator)
    const holding = vi.spyOn(f.coordinator, 'adoptOwnership').mockImplementation(async id => {
      if (id === 'moving') { entered.resolve(); await release.promise }
      return adopt(id)
    })
    try {
      moving = f.succeed('desktop/session/batch', { command: { action: 'move', sessionIds: ['moving'], projectId: 'q', expectedOwners: { moving: 'p' } } })
      const reachedFence = await Promise.race([entered.promise.then(() => true), moving.then(() => false)])
      expect(reachedFence).toBe(true)
      expect(await f.call('desktop/session/input/submit', submit('moving'))).toMatchObject({ error: { code: INVALID_PARAMS } })
      expect(await f.saved('moving')).toEqual(before)
      expect(f.produceReply).toHaveBeenCalledOnce()
    } finally { release.resolve(); holding.mockRestore() }
    expect(await moving).toMatchObject({ results: [{ sessionId: 'moving', projectId: 'q', executionWorkspace: f.workspace, ok: true }] })
    expect(await f.succeed('desktop/session/project/state', { sessionId: 'moving' })).toMatchObject({ projectId: 'q' })
    expect(await f.succeed('desktop/session/input/submit', submit('moving'))).toMatchObject({ accepted: true })
    await f.finished('moving', 2)
    expect(f.produceReply).toHaveBeenCalledTimes(2)
    const request = f.produceReply.mock.calls[1]![0]
    const context = JSON.stringify([request.systemPrompt, request.messages])
    expect(context).toContain(destinationRule)
    expect(context).not.toContain(originRule)
    expect(fromJSONL((await f.saved('moving')).toString()).events.filter(event => event.type === 'assistant/message' && event.text === 'fixture answer')).toHaveLength(2)
  } finally { release.resolve(); await moving?.catch(() => {}); await f.close() }
}, 45_000)

it('keeps the unchecked input handler on the original v1 capability and call shape', async () => {
  const frames: RpcMessage[] = []
  const service = executor.createSessionService({ workspace: process.cwd(), modelPolicy: 'required' })
  const admit = vi.fn(async () => ({ accepted: true, inputId: 'old-input', delivery: 'queue' }))
  const handlers: DesktopHandlers = { input: { admit } as unknown as NonNullable<DesktopHandlers['input']> }
  const send = (frame: RpcMessage) => frames.push(frame)
  const router = createDesktopRouter(createSdkServer(service, { onWrite: createGatewayWrite(send, handlers) }), send, handlers)
  try {
    await router.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }))
    expect(frames.at(-1)).toMatchObject({ result: { capabilities: { 'desktop-input': ['1'] } } })
    await router.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'desktop/session/input/submit', params: submit('plain') }))
    expect(admit).toHaveBeenCalledExactlyOnceWith('plain', { text: 'fixture input', delivery: 'queue', clientToken: 'checked-input-token' })
    expect(frames.at(-1)).toMatchObject({ result: { accepted: true, inputId: 'old-input' } })
  } finally { await router.close(); await service.close() }
})
