import { afterEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { createExecutionLease, type TransportExecutionBackend } from '@i-harness/sandbox'
import { compileExecutionPolicy } from '@i-harness/sandbox-policy'
import { createExecServiceWithReservation } from '../src/service.ts'
import { createExecutionSupervisor } from '../src/execution-supervisor.ts'
import type { ExecCommand, ExecResultRetention, ExecStreamRunOptions, ExecFrameCapture, ExecRunOptions } from '../src/index.ts'
import { createExecFrameCapture } from '../../output-retention/src/result/exec-frames.ts'

vi.mock('node:crypto', async original => ({ ...await original<typeof import('node:crypto')>(), randomUUID: vi.fn() }))
const uuid = '12345678-1234-4123-8123-123456789abc' as ReturnType<typeof randomUUID>
afterEach(() => vi.restoreAllMocks())
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function fixture(retention?: ExecResultRetention) {
  vi.mocked(randomUUID).mockReturnValue(uuid)
  const events: string[] = [], supervisor = createExecutionSupervisor()
  let launches = 0, hostDisposals = 0, releaseAllowed = true, iteratorFailure: unknown
  let failIterator = false
  let publicationFailure: { cause: unknown } | undefined, emit = false
  const roots: Array<() => void> = []
  const backend: TransportExecutionBackend = {
    async probe() { return { id: 'attachment', availability: 'available', assurance: 'unverified', features: { writeIsolation: false, readIsolation: false, denyPaths: false, pipes: true, pty: false, retainedTree: true } } },
    async prepare(spec, policy) { return { policy, async rollback() {}, async commit(check) {
      check(); launches++; events.push('launch')
      const root = deferred<{ exitCode: number }>()
      roots.push(() => root.resolve({ exitCode: 0 }))
      const lease = createExecutionLease({ receipt: { executionId: `attachment-${launches}`, backendId: 'attachment', policyFingerprint: policy.fingerprint, owner: spec.owner, assurance: 'unverified' },
        rootExited: root.promise, async waitTreeEmpty() { await root.promise }, async settleIo() {},
        async releaseResources() { events.push('release'); if (!releaseAllowed) throw new Error('release debt') },
        async terminate() { events.push('cancel'); root.resolve({ exitCode: 0 }) } })
      let rootReads = 0
      return { ...lease, get rootExited() { if (++rootReads === 3 && publicationFailure) throw publicationFailure.cause; return lease.rootExited },
        get settled() { return lease.settled }, pid: 1, io: { async write() {}, async endInput() {},
        output: { [Symbol.asyncIterator]() { events.push('iterator'); if (failIterator) throw iteratorFailure; return (async function* () { if (emit) yield { channel: 'stdout' as const, data: Buffer.from('retained') }; await root.promise })() } } } }
    } } },
  }
  const pair = createExecServiceWithReservation({ resultRetention: retention, execution: { supervisor, defaultOwner: { sessionId: 'attachment-owner' },
    selectBackend: () => backend, validateAuthority() {}, resolvePolicy: owner => compileExecutionPolicy({ mode: 'danger-full-access', owner, authority: { kind: 'unbound', revision: 'attachment', workspaceRoot: resolve('.') } }),
    async dispose() { hostDisposals++; events.push('host') } } })
  return { ...pair, supervisor, events, counts: () => ({ launches, hostDisposals }),
    allowRelease(value: boolean) { releaseAllowed = value }, failIterator(cause: unknown) { failIterator = true; iteratorFailure = cause },
    failPublication(cause: unknown) { publicationFailure = { cause }; emit = true },
    finish() { roots.forEach(finish => finish()) } }
}
const stream: ExecStreamRunOptions = { stream: { maxBytes: 128, onStdout() {} } }
const modes = ['foreground', 'background', 'stream', 'reserved-foreground', 'reserved-background', 'reserved-stream'] as const
function start(f: ReturnType<typeof fixture>, mode: typeof modes[number], command: ExecCommand) {
  if (mode.startsWith('reserved')) return f.port.start(f.port.reserve(), command, mode === 'reserved-background' ? 'background' : 'foreground', mode === 'reserved-stream' ? stream : undefined)
  return mode === 'background' ? f.service.runBackground(command) : mode === 'stream' ? f.service.run(command, stream) : f.service.run(command)
}
function causes(value: unknown): unknown[] { return value instanceof AggregateError ? value.errors.flatMap(causes) : [value] }

// Deleting the pending UUID after setup rejection would admit the second launch.
it.each(modes)('retains native-attached setup failure and original reservation in %s', async mode => {
  const f = fixture(), boom = { failure: mode }
  f.allowRelease(false)
  const command = { argv: ['controlled'], get timeoutMs(): number { f.events.push('timeout'); throw boom } }
  const outcome = start(f, mode, command).then(value => ({ value }), error => ({ error }))
  try {
    const result = await outcome
    expect(result).toHaveProperty('error')
    if ('error' in result) expect(causes(result.error)).toContain(boom)
    expect(f.events.slice(0, 3)).toEqual(['launch', 'timeout', 'cancel'])
    expect(f.supervisor.list()).toHaveLength(1)
    await expect(f.service.runBackground({ argv: ['loser'] })).rejects.toThrow('Native job instance collision')
    expect(f.counts().launches).toBe(1)
    expect(f.service.listJobViews()).toEqual([])
  } finally { f.allowRelease(true); f.finish(); await f.service.dispose() }
  expect(f.counts()).toEqual({ launches: 1, hostDisposals: 1 })
})

it.each([undefined, null, false, 0])('preserves falsey attached setup cause %s without a native result', async boom => {
  const f = fixture()
  try {
    const result = await f.service.run({ argv: ['controlled'], get timeoutMs(): number { throw boom } }).then(value => ({ value }), error => ({ error }))
    expect(result).toEqual({ error: boom })
    expect(f.events).toContain('cancel')
    expect(f.supervisor.list()).toEqual([])
    expect(f.service.listJobViews()).toEqual([])
  } finally { f.finish(); await f.service.dispose() }
})

// A frame returned before iterator setup fails must be sealed and passively settled.
it('keeps actual partial frames across setup failure and disposal retry without observing', async () => {
  let sealed: string | undefined, settleAllowed = false, settlements = 0, observations = 0
  const frames: ExecFrameCapture = { sourceId: 'process:execution-1', async write() {}, complete(value: string) { sealed = value },
    async settle() { settlements++; return settleAllowed ? { kind: 'ready' as const, dependency: { kind: 'exec-frames' as const, sourceId: 'process:execution-1', retention: { kind: 'unavailable' as const, reason: 'quota', observedEncodedBytes: 9 } } } : { kind: 'recovery-required' as const } } }
  const owner: ExecResultRetention = { begin() { expect(this).toBe(owner); return frames }, async settle(actual) { expect(this).toBe(owner); expect(actual).toBe(frames); return actual.settle() }, async observe() { observations++; return { kind: 'recovery-required' } } }
  const f = fixture(owner), boom = new Error('iterator setup')
  f.allowRelease(false)
  f.failIterator(boom)
  try {
    const error = await f.service.runBackground({ argv: ['controlled'] }).catch(error => error)
    expect(causes(error)).toContain(boom)
    expect(sealed).toBe('producer-incomplete')
    expect(settlements).toBeGreaterThan(0)
    const beforeDispose = settlements
    await expect(f.service.dispose()).rejects.toThrow()
    expect(settlements).toBeGreaterThan(beforeDispose)
    expect(f.counts().hostDisposals).toBe(0)
    settleAllowed = true
    await expect(f.service.dispose()).rejects.toThrow()
    expect(f.counts().hostDisposals).toBe(0)
    f.allowRelease(true)
    await f.service.dispose()
    expect(observations).toBe(0)
    expect(f.counts()).toEqual({ launches: 1, hostDisposals: 1 })
  } finally { settleAllowed = true; f.allowRelease(true); f.finish(); await f.service.dispose() }
})

it('cancels real native ownership when begin throws before returning frames', async () => {
  const boom = new Error('begin failure')
  let settlements = 0, observations = 0
  const owner: ExecResultRetention = {
    begin(input) { expect(this).toBe(owner); expect(input).toMatchObject({ sourceId: 'process:execution-1', owner: { sessionId: 'attachment-owner' } }); throw boom },
    async settle() { settlements++; return { kind: 'recovery-required' } },
    async observe() { observations++; return { kind: 'recovery-required' } },
  }
  const f = fixture(owner)
  try {
    await expect(f.service.runBackground({ argv: ['controlled'] })).rejects.toBe(boom)
    expect(f.events).toContain('cancel')
    expect(f.service.listJobViews()).toEqual([])
    expect(settlements).toBe(0)
    expect(observations).toBe(0)
  } finally { f.finish(); await f.service.dispose() }
})

it('cancels before joining an admitted actual frame write on publication failure', async () => {
  const writing = deferred<void>(), finishWrite = deferred<void>(), boom = new Error('publication getter')
  const frames = createExecFrameCapture({ sourceId: 'process:execution-1', async openArtifact() {
    writing.resolve(); await finishWrite.promise
    throw Object.assign(new Error('quota'), { code: 'ARTIFACT_QUOTA' })
  } })
  const declarations: string[] = []
  const complete = frames.complete.bind(frames)
  frames.complete = value => { complete(value); declarations.push(value) }
  let observations = 0
  const owner: ExecResultRetention = { begin: () => frames, settle: capture => capture.settle(), async observe() { observations++; return { kind: 'recovery-required' } } }
  const f = fixture(owner)
  f.failPublication(boom)
  let returned = false
  const result = f.service.runBackground({ argv: ['controlled'] }).then(value => ({ value }), error => ({ error })).finally(() => { returned = true })
  try {
    await writing.promise
    await vi.waitFor(() => expect(f.events).toContain('cancel'))
    expect(returned).toBe(false)
    expect(declarations).toEqual([])
    expect(f.service.listJobViews()).toEqual([])
    finishWrite.resolve()
    expect(await result).toEqual({ error: boom })
    expect(declarations).toEqual(['producer-incomplete'])
    expect(await frames.settle()).toMatchObject({ kind: 'ready', dependency: { retention: { kind: 'unavailable', reason: 'quota' } } })
    expect(observations).toBe(0)
    expect(f.counts().launches).toBe(1)
  } finally { finishWrite.resolve(); f.finish(); await result; await f.service.dispose() }
})

it('coalesces concurrent service disposal through the original host and retains completion', async () => {
  const f = fixture()
  await Promise.all([f.service.dispose(), f.service.dispose(), f.service.dispose()])
  await f.service.dispose()
  expect(f.counts().hostDisposals).toBe(1)
})

it('removes the captured command listener after a prelaunch request getter fails', async () => {
  const f = fixture(), controller = new AbortController(), listeners = new Set<EventListenerOrEventListenerObject>()
  const add = controller.signal.addEventListener.bind(controller.signal), remove = controller.signal.removeEventListener.bind(controller.signal)
  vi.spyOn(controller.signal, 'addEventListener').mockImplementation((name, listener, options) => { listeners.add(listener); add(name, listener, options) })
  vi.spyOn(controller.signal, 'removeEventListener').mockImplementation((name, listener, options) => { listeners.delete(listener); remove(name, listener, options) })
  const boom = new Error('request getter')
  try {
    await expect(f.service.runBackground({ abortSignal: controller.signal, get argv(): string[] { throw boom } })).rejects.toBe(boom)
    expect(listeners.size).toBe(0)
    expect(f.counts().launches).toBe(0)
  } finally { await f.service.dispose() }
})

it.each(['throw', 'reject'] as const)('rejects promptly when original setup cancellation %s fails before native exit', async kind => {
  const f = fixture(), boom = new Error('timeout getter'), cancellation = { cleanup: kind }
  f.supervisor.cancel = () => { if (kind === 'throw') throw cancellation; return Promise.reject(cancellation) }
  let returned = false
  const result = f.service.runBackground({ argv: ['controlled'], get timeoutMs(): number { throw boom } })
    .then(value => ({ value }), error => ({ error })).finally(() => { returned = true })
  try {
    await vi.waitFor(() => expect(returned).toBe(true), { timeout: 100 })
    const outcome = await result
    expect(outcome).toHaveProperty('error')
    if ('error' in outcome) { expect(causes(outcome.error)).toContain(boom); expect(causes(outcome.error)).toContain(cancellation) }
    expect(f.supervisor.list()).toHaveLength(1)
    await expect(f.service.runBackground({ argv: ['loser'] })).rejects.toThrow('Native job instance collision')
  } finally { f.finish(); await result; await f.service.dispose() }
  expect(f.counts().launches).toBe(1)
})

it.each(['background', 'reserved-background'] as const)('owns a late original launch handoff across %s disposal without publishing', async mode => {
  const f = fixture(), launched = deferred<void>(), handoff = deferred<void>()
  const launch = f.supervisor.launch
  f.supervisor.launch = async request => {
    const original = await launch(request)
    launched.resolve(); await handoff.promise
    return original
  }
  let timeoutReads = 0
  const result = start(f, mode, { argv: ['controlled'], get timeoutMs() { timeoutReads++; return 1000 } })
    .then(value => ({ value }), error => ({ error }))
  await launched.promise
  const dispose = f.service.dispose()
  try {
    handoff.resolve()
    expect(await result).toHaveProperty('error')
    await dispose
    expect(timeoutReads).toBe(0)
    expect(f.events.filter(event => event === 'cancel')).toHaveLength(1)
    expect(f.service.listJobViews()).toEqual([])
    expect(f.counts()).toEqual({ launches: 1, hostDisposals: 1 })
  } finally { handoff.resolve(); f.finish(); await result; await dispose; await f.service.dispose() }
})

it('cleans through the original external signal without reading its command getter again', async () => {
  const f = fixture(), controller = new AbortController(), boom = new Error('setup')
  let reads = 0
  try {
    await expect(f.service.runBackground({ argv: ['controlled'],
      get abortSignal() { if (++reads > 1) throw new Error('signal reread'); return controller.signal },
      get timeoutMs(): number { throw boom },
    })).rejects.toBe(boom)
    expect(reads).toBe(1)
    expect(f.events).toContain('cancel')
  } finally { f.finish(); await f.service.dispose() }
})

function promotionWake() {
  let pending = false
  const listeners = new Set<() => void>()
  return {
    source: { pending: () => pending, subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } } },
    admit() { pending = true; for (const listener of [...listeners]) listener() },
    listenerCount: () => listeners.size,
  }
}

it.each([
  ['foreground', 'deadline'], ['foreground', 'user-steer'], ['foreground', 'background-event'],
  ['reserved-foreground', 'deadline'], ['reserved-foreground', 'user-steer'], ['reserved-foreground', 'background-event'],
] as const)('cancels failed %s %s promotion before joining its original active producer', async (mode, trigger) => {
  const writing = deferred<void>(), finishWrite = deferred<void>(), boom = new Error('promotion publication getter'), wake = promotionWake()
  const frames = createExecFrameCapture({ sourceId: 'process:execution-1', async openArtifact() {
    writing.resolve(); await finishWrite.promise
    throw Object.assign(new Error('quota'), { code: 'ARTIFACT_QUOTA' })
  } })
  const declarations: string[] = []
  const complete = frames.complete.bind(frames)
  frames.complete = value => { complete(value); declarations.push(value) }
  let observations = 0
  const owner: ExecResultRetention = { begin: () => frames, settle(actual) { expect(actual).toBe(frames); return actual.settle() },
    async observe() { observations++; return { kind: 'recovery-required' } } }
  const f = fixture(owner)
  f.failPublication(boom); f.allowRelease(false)
  const options: ExecRunOptions = trigger === 'deadline' ? { backgroundAfterMs: 10 }
    : trigger === 'user-steer' ? { promotionWake: wake.source } : { backgroundEventWake: wake.source }
  const command = { argv: ['controlled'] }
  let returned = false
  const reservation = mode === 'reserved-foreground' ? f.port.reserve() : undefined
  if (reservation) expect(f.port.instanceId(reservation)).toBe(uuid)
  const result = (reservation ? f.port.start(reservation, command, 'foreground', options) : f.service.run(command, options))
    .then(value => ({ value }), error => ({ error })).finally(() => { returned = true })
  try {
    await writing.promise
    expect(f.events).not.toContain('release')
    if (trigger !== 'deadline') { expect(wake.listenerCount()).toBe(1); wake.admit() }
    await vi.waitFor(() => expect(f.events).toContain('cancel'), { timeout: 150 })
    expect(returned).toBe(false)
    expect(declarations).toEqual([])
    expect(f.service.listJobViews()).toEqual([])
    expect(wake.listenerCount()).toBe(0)
    finishWrite.resolve()
    const outcome = await result
    expect(outcome).toHaveProperty('error')
    if ('error' in outcome) {
      expect(causes(outcome.error)).toContain(boom)
      expect(causes(outcome.error).some(cause => cause instanceof Error && cause.message.includes('release debt'))).toBe(true)
    }
    expect(declarations).toEqual(['producer-incomplete'])
    expect(await frames.settle()).toMatchObject({ kind: 'ready', dependency: { retention: { kind: 'unavailable', reason: 'quota' } } })
    await expect(f.service.runBackground({ argv: ['loser'] })).rejects.toThrow('Native job instance collision')
    expect(f.counts().launches).toBe(1)
    expect(f.events.filter(event => event === 'cancel')).toHaveLength(1)
    expect(observations).toBe(0)
  } finally { finishWrite.resolve(); f.allowRelease(true); f.finish(); await result; await f.service.dispose() }
  expect(f.counts()).toEqual({ launches: 1, hostDisposals: 1 })
})

it.each([
  ['background', undefined], ['background', null], ['background', false], ['background', 0], ['background', { publication: 'public' }],
  ['reserved-background', undefined], ['reserved-background', null], ['reserved-background', false], ['reserved-background', 0], ['reserved-background', { publication: 'reserved' }],
] as const)('preserves %s publication primary %s alongside original cleanup debt', async (mode, primary) => {
  const f = fixture()
  f.failPublication(primary); f.allowRelease(false)
  try {
    const outcome = await start(f, mode, { argv: ['controlled'] }).then(value => ({ value }), error => ({ error }))
    expect(outcome).toHaveProperty('error')
    if ('error' in outcome) {
      expect(causes(outcome.error)).toContain(primary)
      expect(causes(outcome.error).some(cause => cause instanceof Error && cause.message.includes('release debt'))).toBe(true)
    }
    expect(f.service.listJobViews()).toEqual([])
    expect(f.supervisor.list()).toHaveLength(1)
    await expect(f.service.runBackground({ argv: ['loser'] })).rejects.toThrow('Native job instance collision')
    expect(f.counts().launches).toBe(1)
    expect(f.events.filter(event => event === 'cancel')).toHaveLength(1)
  } finally { f.allowRelease(true); f.finish(); await f.service.dispose() }
  expect(f.counts()).toEqual({ launches: 1, hostDisposals: 1 })
})
