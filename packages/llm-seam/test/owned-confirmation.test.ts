import { openOwnedPreparedStream, readDrainedOwnedExecutionConfirmation } from '../src/prepared/stream-lifetime.ts'
import { createServer } from 'node:http'
import { afterEach, expect, it } from 'vitest'
import { ProjectionCounter } from '@i-harness/token-meter'
import { createGenerationControl, createPreparedHttpPayload, createPreparedPayload, createRetryingClient, createWaitingGuard, observeModelClient, prepareModelRequest, preparedExecutionSource, preparedModelClient, resolveRetryPolicy, withPreparedSignal, wrapPreparedRequest, type ExecutionConfirmation, type LLMStreamEvent, type PreparedModelRequest } from '../src/index.ts'
import * as payloadModule from '../src/prepared/payload.ts'

const request = { systemPrompt: '', messages: [], tools: [] }
const identity = { version: 1 as const, runtimeId: 'runtime', bindingLifetimeId: 'binding', authEpoch: 'epoch', scope: 'binding-credential' as const, coldCompatible: false as const }
const servers: ReturnType<typeof createServer>[] = []
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) } })
async function loopback(status: number | ((attempt: number) => number) = 200) {
  const received: string[] = []
  const server = createServer(async (incoming, response) => {
    let body = ''; for await (const chunk of incoming) body += chunk
    received.push(body); response.writeHead(typeof status === 'number' ? status : status(received.length)); response.end('ok')
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, received }
}
function options(cap: (body: { cap: number }, cap: number | undefined) => { cap: number } = (_body, cap) => ({ cap: cap ?? 10 })) {
  return { body: { cap: 10 }, request,
    describe(body: { cap: number }) { const counter = new ProjectionCounter('projected-pricing-v2'); counter.structured('otherInput', body); return { input: counter.finish({ protocol: 'test', modelId: 'm' }, body, body), packet: { sizeKind: 'http-json-body' as const, inlineBinaryBytes: 0, cacheMetadataBytes: 0, signatureBytes: 0 } } },
    output: (body: { cap: number }) => ({ capSupport: 'supported' as const, effectiveCap: body.cap, minimumCap: 1, source: 'request' as const }), cap,
  }
}
function http(url: string, extra: { cap?: ReturnType<typeof options>['cap']; fetchOverride?: typeof fetch; read?: () => AsyncIterable<LLMStreamEvent> } = {}) {
  return createPreparedHttpPayload({ ...options(extra.cap), transport: { label: 'loopback', fetchOverride: extra.fetchOverride,
    prepare: () => ({ url, init: {}, state: undefined, identity }),
    async *read() { if (extra.read) yield* extra.read(); else yield { type: 'end' } },
  } })
}
async function drain(prepared: PreparedModelRequest, controls?: Parameters<PreparedModelRequest['stream']>[0]) {
  const events: LLMStreamEvent[] = []; for await (const event of prepared.stream(controls)) events.push(event); return events
}

it('fixed retry/wait/observation/signal caps derive the one handle actually executed once', async () => {
  const server = await loopback(), caps: number[] = []
  const terminal = http(server.url, { cap: (_body, cap) => { caps.push(cap!); return { cap: cap! } } })
  const observed = observeModelClient(preparedModelClient(async () => terminal), { start() {}, finish() {} })
  const retry = createRetryingClient(observed, resolveRetryPolicy({ mode: 'normal', maxRetries: 1 }))
  const prepared = withPreparedSignal(await prepareModelRequest(createWaitingGuard(retry, { firstResponseMs: 1000, progressMs: 1000 }), request), () => undefined)
  const derived = prepared.withOutputCap(7)
  expect(caps).toEqual([7])
  expect(derived.measurement.payloadIdentity).toEqual(preparedExecutionSource(derived).measurement.payloadIdentity)
  await drain(derived)
  expect(server.received).toEqual(['{"cap":7}'])
})

// Package-private until a genuine cooperation consumer is introduced.
const read = (confirmation: ExecutionConfirmation, prepared: PreparedModelRequest) => payloadModule.readOwnedExecutionConfirmation(confirmation, prepared)

it('makes original confirmation evidence available only after issue and observed successful completion for the exact executed source', async () => {
  const server = await loopback(), before: unknown[] = []
  let confirmation: ExecutionConfirmation | undefined
  const terminal = http(server.url, { async *read() { before.push(read(confirmation!, terminal)); yield { type: 'end' } } })
  await drain(terminal, {
    confirmExecution(value) { confirmation = value; before.push(read(value, terminal)) },
    onTransportIssue() { before.push(read(confirmation!, terminal)) },
  })
  expect(before).toEqual([undefined, undefined, undefined])
  expect(server.received).toEqual(['{"cap":10}'])
  const facts = read(confirmation!, terminal)
  expect(facts).toEqual({ version: 1, sendId: confirmation!.sendId, semanticId: confirmation!.semanticId, payloadId: confirmation!.payloadId, payloadKind: 'http-json-body' })
  expect(Object.isFrozen(facts)).toBe(true)
  expect(read({ ...confirmation! }, terminal)).toBeUndefined()
  expect(read(confirmation!, http(server.url))).toBeUndefined()
  expect(read(confirmation!, terminal.withOutputCap(10))).toBeUndefined()
  expect(read(confirmation!, terminal.withOutputCap(7))).toBeUndefined()
  expect(confirmation!.identity).toEqual(identity)
})

it('matches confirmation provenance through fixed wrappers to their single actual cap derivative', async () => {
  const server = await loopback()
  const terminal = http(server.url)
  const observed = observeModelClient(preparedModelClient(async () => terminal), { start() {}, finish() {} })
  const retry = createRetryingClient(observed, resolveRetryPolicy({ mode: 'normal', maxRetries: 1 }))
  const original = withPreparedSignal(await prepareModelRequest(createWaitingGuard(retry, { firstResponseMs: 1000, progressMs: 1000 }), request), () => undefined)
  const prepared = original.withOutputCap(7)
  let confirmation: ExecutionConfirmation | undefined
  await drain(prepared, { confirmExecution: value => { confirmation = value } })
  expect(read(confirmation!, prepared)).toMatchObject({ payloadId: prepared.measurement.payloadIdentity!.id })
  expect(read(confirmation!, preparedExecutionSource(prepared))).toBeDefined()
  expect(read(confirmation!, original)).toBeUndefined()
  expect(read(confirmation!, terminal)).toBeUndefined()
})

it('records successful reservation issue and terminal end, and keeps failed retry confirmations unverified', async () => {
  const server = await loopback(attempt => attempt === 1 ? 503 : 200)
  const terminal = http(server.url), confirmations: ExecutionConfirmation[] = [], lifecycle: string[] = []
  const generation = createGenerationControl({ signal: new AbortController().signal, async reserve() {
    lifecycle.push('reserve')
    return { issue() { lifecycle.push('issue') }, async settle(disposition) { lifecycle.push(disposition) } }
  } })
  const retry = createRetryingClient(preparedModelClient(async () => terminal), resolveRetryPolicy({ mode: 'normal', maxRetries: 1, backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } }))
  const prepared = (await prepareModelRequest(retry, request)).withOutputCap(7)
  await drain(prepared, { generation, confirmExecution: value => { confirmations.push(value) } })
  expect(server.received).toEqual(['{"cap":7}', '{"cap":7}'])
  expect(lifecycle).toEqual(['reserve', 'issue', 'failed', 'reserve', 'issue', 'completed'])
  expect(confirmations).toHaveLength(2)
  expect(read(confirmations[0]!, prepared)).toBeUndefined()
  expect(read(confirmations[1]!, prepared)).toBeDefined()
})

it('captures the fetch override at preparation so later mutation cannot replace the owned invocation', async () => {
  const server = await loopback()
  let replacements = 0, confirmation: ExecutionConfirmation | undefined
  const transport = { label: 'loopback', fetchOverride: undefined as typeof fetch | undefined,
    prepare: () => ({ url: server.url, init: {}, state: undefined, identity }),
    async *read(): AsyncIterable<LLMStreamEvent> { yield { type: 'end' } },
  }
  const prepared = createPreparedHttpPayload({ ...options(), transport })
  transport.fetchOverride = async () => { replacements++; return new Response('fake') }
  await drain(prepared, { confirmExecution: value => { confirmation = value } })
  expect(replacements).toBe(0)
  expect(server.received).toEqual(['{"cap":10}'])
  expect(read(confirmation!, prepared)).toBeDefined()
})

it.each(['http-error', 'error-event', 'throw', 'no-end', 'error-after-end', 'throw-after-end'] as const)('does not verify an issued invocation ending in %s', async failure => {
  const server = await loopback(failure === 'http-error' ? 503 : 200)
  const terminal = http(server.url, { async *read() {
    if (failure === 'error-after-end' || failure === 'throw-after-end') yield { type: 'end' }
    if (failure === 'throw' || failure === 'throw-after-end') throw new Error('decoder failed')
    if (failure === 'error-event' || failure === 'error-after-end') yield { type: 'error', error: new Error('decoder failed') }
  } })
  let confirmation: ExecutionConfirmation | undefined
  try { await drain(terminal, { confirmExecution: value => { confirmation = value } }) } catch (error) { expect((error as Error).message).toBe('decoder failed') }
  expect(server.received).toHaveLength(1)
  expect(confirmation).toBeDefined()
  expect(read(confirmation!, terminal)).toBeUndefined()
})

it('does not verify an invocation the consumer closes before terminal completion', async () => {
  const server = await loopback()
  const terminal = http(server.url, { async *read() { yield { type: 'text/chunk', text: 'partial' }; yield { type: 'end' } } })
  let confirmation: ExecutionConfirmation | undefined
  for await (const _event of terminal.stream({ confirmExecution: value => { confirmation = value } })) break
  expect(read(confirmation!, terminal)).toBeUndefined()
})

it.each(['guard', 'issue'] as const)('does not verify a confirmation rejected by the final %s before send', async failure => {
  const server = await loopback(), terminal = http(server.url)
  let confirmation: ExecutionConfirmation | undefined
  const generation = createGenerationControl({ signal: new AbortController().signal, async reserve() { return { issue() { if (failure === 'issue') throw new Error('blocked') }, async settle() {} } } })
  await expect(drain(terminal, { generation,
    confirmExecution: value => { confirmation = value },
    validateBeforeTransport() { if (failure === 'guard') throw new Error('blocked') },
  })).rejects.toThrow('blocked')
  expect(confirmation).toBeDefined()
  expect(server.received).toEqual([])
  expect(read(confirmation!, terminal)).toBeUndefined()
})

it('preserves ordinary custom-payload confirmations while caller-shaped identity and local-test composition provide no owned evidence', async () => {
  const custom = createPreparedPayload({ ...options(), async *execute(_body, _serialized, _control, execution) { execution.confirm(identity); yield { type: 'end' } } })
  const local = withPreparedSignal({ ...custom, localExecutionIdentity: {} }, () => undefined)
  for (const prepared of [custom, local]) {
    let confirmation: ExecutionConfirmation | undefined
    await drain(prepared, { confirmExecution: value => { confirmation = value } })
    expect(confirmation).toMatchObject({ payloadId: custom.measurement.payloadIdentity!.id, identity })
    expect(read(confirmation!, prepared)).toBeUndefined()
  }
})

it('does not promote fetch overrides or public arbitrary callback wrappers to owned evidence', async () => {
  const server = await loopback(), terminal = http(server.url)
  const custom = http(server.url, { fetchOverride: globalThis.fetch })
  const wrapper = wrapPreparedRequest(terminal, (stream, controls) => stream(controls))
  for (const prepared of [custom, wrapper]) {
    let confirmation: ExecutionConfirmation | undefined
    await drain(prepared, { confirmExecution: value => { confirmation = value } })
    expect(confirmation).toBeDefined()
    expect(read(confirmation!, prepared)).toBeUndefined()
    if (prepared === wrapper) expect(read(confirmation!, terminal)).toBeDefined()
  }
  expect(server.received).toHaveLength(2)
})

it('existing provisional confirmation precedes original decoder cleanup', async () => {
  const server = await loopback()
  let release!: () => void, finished = false, confirmation: ExecutionConfirmation | undefined
  const held = new Promise<void>(resolve => { release = resolve })
  const terminal = http(server.url, { async *read() { try { yield { type: 'end' } } finally { await held; finished = true } } })
  const waiting = await prepareModelRequest(createWaitingGuard(preparedModelClient(async () => terminal), { firstResponseMs: 1000, progressMs: 1000 }), request)
  try {
    const invocation = openOwnedPreparedStream(waiting, { confirmExecution: value => { confirmation = value } })
    for await (const _event of invocation.stream) {}
    expect(server.received).toHaveLength(1)
    expect(finished).toBe(false)
    expect(read(confirmation!, waiting)).toBeDefined()
    expect(readDrainedOwnedExecutionConfirmation(invocation, confirmation!, waiting)).toBeUndefined()
    release()
    await invocation.drain()
    expect(finished).toBe(true)
    expect(readDrainedOwnedExecutionConfirmation(invocation, confirmation!, waiting)).toBeDefined()
    expect(readDrainedOwnedExecutionConfirmation(invocation, { ...confirmation! }, waiting)).toBeUndefined()
    expect(readDrainedOwnedExecutionConfirmation(invocation, confirmation!, waiting.withOutputCap(10))).toBeUndefined()
    expect(readDrainedOwnedExecutionConfirmation({ ...invocation }, confirmation!, waiting)).toBeUndefined()
  } finally { release() }
})

it('retains a falsey decoder cleanup failure and never qualifies the original confirmation', async () => {
  const server = await loopback()
  let release!: () => void, confirmation: ExecutionConfirmation | undefined
  const held = new Promise<void>(resolve => { release = resolve })
  const terminal = http(server.url, { async *read() { try { yield { type: 'end' } } finally { await held; throw undefined } } })
  const waiting = await prepareModelRequest(createWaitingGuard(preparedModelClient(async () => terminal), { firstResponseMs: 1000, progressMs: 1000 }), request)
  const invocation = openOwnedPreparedStream(waiting, { confirmExecution: value => { confirmation = value } })
  try {
    for await (const _event of invocation.stream) {}
    release()
    const failure = await invocation.drain().then(() => 'unexpected success', error => error)
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toContain(undefined)
    expect(readDrainedOwnedExecutionConfirmation(invocation, confirmation!, waiting)).toBeUndefined()
    await expect(invocation.drain()).rejects.toBe(failure)
  } finally { release() }
})

it('keeps concurrent invocations of the same prepared stream and their confirmations separate', async () => {
  const server = await loopback()
  let release!: () => void, count = 0
  const held = new Promise<void>(resolve => { release = resolve })
  const terminal = http(server.url, { async *read() { const ordinal = ++count; try { yield { type: 'end' } } finally { if (ordinal === 1) await held } } })
  const waiting = await prepareModelRequest(createWaitingGuard(preparedModelClient(async () => terminal), { firstResponseMs: 1000, progressMs: 1000 }), request)
  let firstConfirmation: ExecutionConfirmation | undefined, secondConfirmation: ExecutionConfirmation | undefined
  const first = openOwnedPreparedStream(waiting, { confirmExecution: value => { firstConfirmation = value } })
  const second = openOwnedPreparedStream(waiting, { confirmExecution: value => { secondConfirmation = value } })
  try {
    for await (const _event of first.stream) {}
    for await (const _event of second.stream) {}
    await second.drain()
    expect(readDrainedOwnedExecutionConfirmation(second, secondConfirmation!, waiting)).toBeDefined()
    expect(readDrainedOwnedExecutionConfirmation(second, firstConfirmation!, waiting)).toBeUndefined()
    expect(readDrainedOwnedExecutionConfirmation(first, secondConfirmation!, waiting)).toBeUndefined()
    expect(readDrainedOwnedExecutionConfirmation(first, firstConfirmation!, waiting)).toBeUndefined()
    release(); await first.drain()
    expect(readDrainedOwnedExecutionConfirmation(first, firstConfirmation!, waiting)).toBeDefined()
  } finally { release() }
})

it('joins both physical retry flights before qualifying the successful original confirmation', async () => {
  const server = await loopback(attempt => attempt === 1 ? 503 : 200)
  const terminal = http(server.url), confirmations: ExecutionConfirmation[] = []
  const retry = createRetryingClient(preparedModelClient(async () => terminal), resolveRetryPolicy({ mode: 'normal', maxRetries: 1, backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } }))
  const prepared = (await prepareModelRequest(createWaitingGuard(retry, { firstResponseMs: 1000, progressMs: 1000 }), request)).withOutputCap(7)
  const invocation = openOwnedPreparedStream(prepared, { confirmExecution: value => { confirmations.push(value) } })
  for await (const _event of invocation.stream) {}
  await invocation.drain()
  expect(server.received).toHaveLength(2)
  expect(readDrainedOwnedExecutionConfirmation(invocation, confirmations[0]!, prepared)).toBeUndefined()
  expect(readDrainedOwnedExecutionConfirmation(invocation, confirmations[1]!, prepared)).toBeDefined()
})

it('rejects a stale decoder continuation before it can start a second owned stream', async () => {
  const server = await loopback()
  let release!: () => void, late!: Promise<unknown>
  const gate = new Promise<void>(resolve => { release = resolve })
  let terminal: PreparedModelRequest
  terminal = http(server.url, { async *read() {
    late = gate.then(() => terminal.stream())
    yield { type: 'end' }
  } })
  const waiting = await prepareModelRequest(createWaitingGuard(preparedModelClient(async () => terminal), { firstResponseMs: 1000, progressMs: 1000 }), request)
  const invocation = openOwnedPreparedStream(waiting, {})
  for await (const _event of invocation.stream) {}
  await invocation.drain()
  release()
  await expect(late).rejects.toThrow('Owned stream context finalized')
  expect(server.received).toHaveLength(1)
})

it('refuses an original decoder attempting to join its own stream drain', async () => {
  const server = await loopback()
  let invocation!: ReturnType<typeof openOwnedPreparedStream>, selfError: unknown
  const terminal = http(server.url, { async *read() {
    selfError = await invocation.drain().then(() => undefined, error => error)
    yield { type: 'end' }
  } })
  invocation = openOwnedPreparedStream(terminal, {})
  for await (const _event of invocation.stream) {}
  await invocation.drain()
  expect(selfError).toBeInstanceOf(Error)
  expect((selfError as Error).message).toContain('Cannot drain inside owned stream')
})

it('keeps the real pending decoder next and detached return owned after waiting timeout', async () => {
  const server = await loopback()
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
  const terminal = http(server.url, { async *read() { entered(); await gate; yield { type: 'end' } } })
  const waiting = await prepareModelRequest(createWaitingGuard(preparedModelClient(async () => terminal), { firstResponseMs: 30, progressMs: 30 }), request)
  const invocation = openOwnedPreparedStream(waiting, {})
  try {
    const consuming = (async () => { try { for await (const _event of invocation.stream) {} } catch {} })()
    await started; await consuming
    let settled = false
    const draining = invocation.drain().then(() => { settled = true }, () => { settled = true })
    await Promise.resolve(); expect(settled).toBe(false)
    release(); await draining
    expect(settled).toBe(true); expect(server.received).toHaveLength(1)
  } finally { release() }
})

it('joins the delayed first original retry cleanup before qualifying the successful second send', async () => {
  const server = await loopback()
  let release!: () => void, reads = 0
  const gate = new Promise<void>(resolve => { release = resolve })
  const terminal = http(server.url, { async *read() { if (++reads === 1) { try { yield { type: 'error', error: Object.assign(new Error('temporary'), { code: 'TRANSPORT' }) } } finally { await gate } } else yield { type: 'end' } } })
  const waiting = createWaitingGuard(preparedModelClient(async () => terminal), { firstResponseMs: 1000, progressMs: 1000 })
  const retry = createRetryingClient(waiting, resolveRetryPolicy({ mode: 'normal', maxRetries: 1, backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } }))
  const prepared = (await prepareModelRequest(retry, request)).withOutputCap(7), confirmations: ExecutionConfirmation[] = []
  const invocation = openOwnedPreparedStream(prepared, { confirmExecution: value => { confirmations.push(value) } })
  try {
    for await (const _event of invocation.stream) {}
    expect(server.received).toHaveLength(2); expect(confirmations).toHaveLength(2)
    let settled = false; const drain = invocation.drain().then(() => { settled = true })
    await Promise.resolve(); expect(settled).toBe(false)
    expect(readDrainedOwnedExecutionConfirmation(invocation, confirmations[1]!, prepared)).toBeUndefined()
    release(); await drain
    expect(readDrainedOwnedExecutionConfirmation(invocation, confirmations[0]!, prepared)).toBeUndefined()
    expect(readDrainedOwnedExecutionConfirmation(invocation, confirmations[1]!, prepared)).toBeDefined()
  } finally { release() }
})

it('refuses opening an unowned custom prepared terminal as an auxiliary invocation', async () => {
  const server = await loopback(), owned = http(server.url)
  const copied = { ...owned }
  expect(() => openOwnedPreparedStream(copied, {})).toThrow(expect.objectContaining({ code: 'GENERATION_UNSUPPORTED' }))
  expect(server.received).toHaveLength(0)
})
