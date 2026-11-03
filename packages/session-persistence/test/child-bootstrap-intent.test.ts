import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { canonicalJsonData } from '@i-harness/core-session'
import { bootstrapInitialInputDigest } from '@i-harness/core-session/internal/bootstrap'
import {
  captureChildBootstrapCore, createChildBootstrapRequestIntent, captureChildBootstrapCaptureRequest,
  encodeChildBootstrapReservation, parseChildBootstrapReservation, childInitialCommitment,
  type ChildBootstrapCore, type ChildBootstrapCaptureRequest, type ChildBootstrapReservation,
} from '../src/index.ts'
import { captureBootstrapCaptureRequest, encodeBootstrapCaptureReservation, parseBootstrapCaptureReservation } from '../src/coordinator/bootstrap-capture.ts'
import { captureBootstrapRequest, initialAdmission, buildBootstrapHeader, parseBootstrapHeaderStage } from '../src/coordinator/bootstrap-header.ts'
import { createBootstrapRequestIntent } from '../src/coordinator/bootstrap-intent.ts'
import { compileSemanticSeed } from '../src/semantic-seed.ts'
import type { BootstrapRequest } from '../src/coordinator/bootstrap-types.ts'

const core = (): ChildBootstrapCore => ({ version: 1, kind: 'child-bootstrap-core', caller: { kind: 'task', taskId: 'task', parentSessionId: 'parent' },
  history: { selection: { kind: 'none' } }, metadata: {}, lineage: { origin: 'subagent', subagentProtocolVersion: 1, parentSession: 'parent' },
  initial: { inputId: 'input', digest: 'a'.repeat(64), startedAt: 0, expiresAt: 10, parentSessionId: 'parent' },
  execution: { roleName: 'worker', roleDigest: 'b'.repeat(64), toolNames: ['write', 'read'], model: { kind: 'inherit-parent' }, approval: 'ordinary' } })
const request = (c = core(), targetSessionId = 'target'): ChildBootstrapCaptureRequest => {
  const { intent, requestDigest } = createChildBootstrapRequestIntent(c, { kind: 'unassigned' })
  return { version: 1, kind: 'child-bootstrap-capture-request', core: c, requestIntent: intent,
    invocation: { version: 1, operationId: 'op', targetSessionId, createdAt: '2026-10-23T00:00:00.000Z', requestDigest } }
}
const reservation = (r = request()): ChildBootstrapReservation => ({ version: 1, kind: 'semantic-bootstrap-child-capture', request: r })
const mutate = (change: (c: any) => void) => { const c = core(); change(c); return c }
const payload = (): BootstrapRequest => ({ invocation: { version: 1, operationId: 'op', targetSessionId: 'target', createdAt: '2026-10-23T00:00:00.000Z', requestDigest: 'c'.repeat(64) },
  target: { kind: 'new' }, metadata: {}, lineage: { origin: 'subagent', subagentProtocolVersion: 1, parentSession: 'parent' },
  seed: compileSemanticSeed({ kind: 'none' }), initial: { inputId: 'input', text: 'original prompt 😀', startedAt: 0, expiresAt: 10, parentSessionId: 'parent' } })

it('captures all caller branches as frozen independent data and preserves optional absence', () => {
  for (const kind of ['task', 'team', 'approval-review'] as const) {
    const c = core()
    if (kind !== 'task') { c.caller = kind === 'team' ? { kind, teamId: 'team', memberId: 'member' } : { kind, reviewId: 'review' }; c.lineage = { origin: kind, parentSession: 'parent' } }
    if (kind === 'approval-review') { c.execution.approval = 'parent-review'; c.execution.toolNames = [] }
    const captured = captureChildBootstrapCore(c)
    expect(captured).toEqual(c); expect(captured).not.toBe(c)
    expect(Object.isFrozen(captured.execution.toolNames)).toBe(true)
    c.execution.toolNames = ['later']; expect(captured.execution.toolNames).toEqual(kind === 'approval-review' ? [] : ['write', 'read'])
    expect(Object.hasOwn(captured.lineage, 'delegationDepth')).toBe(false)
    expect(Object.hasOwn(captured.execution, 'timeoutMs')).toBe(false)
  }
})

it('enforces every caller, lineage, approval and review-tools combination', () => {
  for (const caller of ['task', 'team', 'approval-review'] as const) for (const origin of ['subagent', 'team', 'approval-review'] as const) for (const approval of ['ordinary', 'parent-review'] as const) {
    const c = core()
    c.caller = caller === 'task' ? c.caller : caller === 'team' ? { kind: caller, teamId: 't', memberId: 'm' } : { kind: caller, reviewId: 'r' }
    c.lineage = origin === 'subagent' ? { origin, subagentProtocolVersion: 1, parentSession: 'parent' } : { origin, parentSession: 'parent' }
    c.execution.approval = approval; c.execution.toolNames = []
    const valid = caller === 'task' && origin === 'subagent' && approval === 'ordinary' || caller === 'team' && origin === 'team' && approval === 'ordinary' || caller === 'approval-review' && origin === 'approval-review' && approval === 'parent-review'
    if (valid) expect(captureChildBootstrapCore(c)).toEqual(c)
    else expect(() => captureChildBootstrapCore(c)).toThrow(TypeError)
  }
  expect(() => captureChildBootstrapCore(mutate(c => { c.caller = { kind: 'approval-review', reviewId: 'r' }; c.lineage = { origin: 'approval-review', parentSession: 'parent' }; c.execution.approval = 'parent-review' }))).toThrow(TypeError)
})

it('accepts none, all and last-turns with exact durable or anonymous lineage equality', () => {
  for (const selection of [{ kind: 'all' }, { kind: 'last-turns', count: 1 }, { kind: 'last-turns', count: Number.MAX_SAFE_INTEGER }] as const) {
    const c = core(); c.history = { selection, source: { kind: 'session', sessionId: 'parent' } }; expect(captureChildBootstrapCore(c)).toEqual(c)
    c.caller = { kind: 'task', taskId: 'task', parentSessionId: '' }; delete c.lineage.parentSession; delete c.initial.parentSessionId
    c.history = { selection, source: { kind: 'anonymous' } }; expect(captureChildBootstrapCore(c)).toEqual(c)
  }
})

it.each([
  ['caller parent', (c: any) => { c.caller.parentSessionId = 'other' }],
  ['empty caller with durable parent', (c: any) => { c.caller.parentSessionId = '' }],
  ['initial parent', (c: any) => { c.initial.parentSessionId = 'other' }],
  ['missing initial parent', (c: any) => { delete c.initial.parentSessionId }],
  ['none source', (c: any) => { c.history.source = { kind: 'anonymous' } }],
  ['all missing source', (c: any) => { c.history = { selection: { kind: 'all' } } }],
  ['anonymous durable parent', (c: any) => { c.history = { selection: { kind: 'all' }, source: { kind: 'anonymous' } } }],
  ['different source', (c: any) => { c.history = { selection: { kind: 'all' }, source: { kind: 'session', sessionId: 'other' } } }],
  ['completed history', (c: any) => { c.history = { selection: { kind: 'completed' }, source: { kind: 'session', sessionId: 'parent' } } }],
  ['missing protocol', (c: any) => { delete c.lineage.subagentProtocolVersion }],
  ['future protocol', (c: any) => { c.lineage.subagentProtocolVersion = 2 }],
  ['protocol on team', (c: any) => { c.lineage.origin = 'team'; c.caller = { kind: 'team', teamId: 't', memberId: 'm' } }],
  ['empty role', (c: any) => { c.execution.roleName = '' }],
  ['empty tool', (c: any) => { c.execution.toolNames = [''] }],
  ['uppercase digest', (c: any) => { c.initial.digest = 'A'.repeat(64) }],
  ['bad role digest', (c: any) => { c.execution.roleDigest = 'x' }],
  ['unknown model', (c: any) => { c.execution.model = { kind: 'resolved' } }],
  ['invalid source path', (c: any) => { c.history = { selection: { kind: 'all' }, source: { kind: 'session', sessionId: '../bad' } }; delete c.lineage.parentSession; delete c.initial.parentSessionId; c.caller.parentSessionId = '' }],
])('rejects %s', (_name, change) => { expect(() => captureChildBootstrapCore(mutate(change))).toThrow(TypeError) })

it('enforces safe integer boundaries and original timeout clock without defaults', () => {
  for (const n of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) for (const path of ['callEventSeq', 'delegationDepth', 'startedAt', 'expiresAt']) {
    const c = mutate(c => { if (path === 'callEventSeq') c.caller[path] = n; else if (path === 'delegationDepth') c.lineage[path] = n; else c.initial[path] = n })
    expect(() => captureChildBootstrapCore(c)).toThrow(TypeError)
  }
  for (const n of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) for (const path of ['timeoutMs', 'maxAttempts', 'count']) {
    expect(() => captureChildBootstrapCore(mutate(c => { if (path === 'count') c.history = { selection: { kind: 'last-turns', count: n }, source: { kind: 'session', sessionId: 'parent' } }; else c.execution[path] = n }))).toThrow(TypeError)
  }
  const c = core(); c.execution.timeoutMs = 10; c.execution.maxAttempts = Number.MAX_SAFE_INTEGER; c.lineage.delegationDepth = 0
  c.caller = { kind: 'task', taskId: 'task', parentSessionId: 'parent', callEventSeq: 0, toolCallId: '' }
  expect(captureChildBootstrapCore(c)).toEqual(c)
  c.execution.timeoutMs = 9; expect(() => captureChildBootstrapCore(c)).toThrow(TypeError)
  c.initial.startedAt = Number.MAX_SAFE_INTEGER - 1; c.initial.expiresAt = Number.MAX_SAFE_INTEGER; c.execution.timeoutMs = 2
  expect(() => captureChildBootstrapCore(c)).toThrow(TypeError)
  for (const expiresAt of [0, -1]) expect(() => captureChildBootstrapCore(mutate(c => { c.initial.expiresAt = expiresAt }))).toThrow(TypeError)
})

it('reuses metadata model and title rules while comparing declared model exactly', () => {
  for (const protocol of ['openai-completions', 'openai-responses', 'anthropic-messages', 'gemini', 'bedrock'] as const) {
    const c = core(), selection = { provider: 'custom', model: 'unresolved', protocol, reasoningEffort: 'future' }
    c.metadata = { title: '😀'.repeat(8192), workspaceId: 'workspace', modelSelection: selection }; c.execution.model = { kind: 'declared', selection }
    expect(captureChildBootstrapCore(c)).toEqual(c)
    c.metadata.modelSelection = { ...selection, model: 'other' }; expect(() => captureChildBootstrapCore(c)).toThrow(TypeError)
    delete c.metadata.modelSelection; expect(captureChildBootstrapCore(c)).toEqual(c)
  }
  for (const change of [(c: any) => { c.metadata.title = '😀'.repeat(8193) }, (c: any) => { c.metadata.workspaceId = '' }, (c: any) => { c.execution.model = { kind: 'declared', selection: { provider: 'p', model: 'm', protocol: 'future' } } }, (c: any) => { c.execution.model = { kind: 'declared', selection: { provider: 'p'.repeat(257), model: 'm' } } }]) expect(() => captureChildBootstrapCore(mutate(change))).toThrow(TypeError)
  const inherited = core(); inherited.metadata.modelSelection = { provider: 'unresolved', model: 'data-only' }
  expect(captureChildBootstrapCore(inherited).execution.model).toEqual({ kind: 'inherit-parent' })
  const longNames = core(); longNames.execution.roleName = 'r'.repeat(1000); longNames.execution.toolNames = ['t'.repeat(1000)]
  longNames.caller = { kind: 'task', taskId: 't'.repeat(1000), parentSessionId: 'parent', toolCallId: 'c'.repeat(1000), callEventSeq: Number.MAX_SAFE_INTEGER }
  longNames.initial.inputId = 'i'.repeat(256); expect(captureChildBootstrapCore(longNames)).toEqual(longNames)
  longNames.initial.inputId += 'i'; expect(() => captureChildBootstrapCore(longNames)).toThrow(TypeError)
})

it('rejects malformed descriptors at every nested boundary without evaluating effects', () => {
  let effects = 0
  const hostile = [Object.defineProperty({}, 'kind', { enumerable: true, get() { effects++; return 'task' } }),
    Object.defineProperty({}, 'hidden', { value: 1 }), new Proxy({}, { ownKeys() { effects++; return [] } }), { [Symbol('x')]: 1 }, { extra: true }, { kind: undefined },
    { toJSON() { effects++; return {} } }]
  for (const value of hostile) {
    expect(() => captureChildBootstrapCore(value)).toThrow(TypeError)
    for (const field of ['caller', 'history', 'metadata', 'lineage', 'initial', 'execution']) expect(() => captureChildBootstrapCore({ ...core(), [field]: value })).toThrow(TypeError)
    expect(() => createChildBootstrapRequestIntent(core(), value as any)).toThrow(TypeError)
    expect(() => captureChildBootstrapCaptureRequest(value)).toThrow(TypeError)
    expect(() => encodeChildBootstrapReservation(value as any)).toThrow(TypeError)
  }
  for (const value of [Array(1), [undefined], Object.assign(['read'], { extra: true }), Object.defineProperty(['read'], '0', { enumerable: false }), new Proxy(['read'], { get() { effects++; return 'bad' } })]) expect(() => captureChildBootstrapCore(mutate(c => { c.execution.toolNames = value }))).toThrow(TypeError)
  for (const change of [(c: any) => { c.extra = true }, (c: any) => { c.execution.timeoutMs = undefined }, (c: any) => { c.execution.model.selection = {} }, (c: any) => { c.caller.extra = true }]) expect(() => captureChildBootstrapCore(mutate(change))).toThrow(TypeError)
  expect(effects).toBe(0)
})

it('closes every nested object and request wrapper before getters or proxy traps can run', () => {
  let effects = 0
  const elaborate = () => {
    const c = core(); c.history = { selection: { kind: 'all' }, source: { kind: 'session', sessionId: 'parent' } }
    c.execution.model = { kind: 'declared', selection: { provider: 'p', model: 'm' } }
    c.metadata.modelSelection = { provider: 'p', model: 'm' }
    return c
  }
  const boundaries = [(c: any) => c, (c: any) => c.caller, (c: any) => c.history, (c: any) => c.history.selection,
    (c: any) => c.history.source, (c: any) => c.metadata, (c: any) => c.metadata.modelSelection, (c: any) => c.lineage,
    (c: any) => c.initial, (c: any) => c.execution, (c: any) => c.execution.model, (c: any) => c.execution.model.selection]
  for (const boundary of boundaries) for (const shape of ['extra', 'undefined', 'getter', 'hidden', 'symbol'] as const) {
    const c = elaborate(), object = boundary(c)
    if (shape === 'symbol') object[Symbol('field')] = 1
    else if (shape === 'getter') Object.defineProperty(object, 'unexpected', { enumerable: true, get() { effects++; return 1 } })
    else if (shape === 'hidden') Object.defineProperty(object, 'unexpected', { value: 1 })
    else object.unexpected = shape === 'undefined' ? undefined : true
    expect(() => captureChildBootstrapCore(c)).toThrow(TypeError)
  }
  for (const boundary of [(r: any) => r, (r: any) => r.invocation, (r: any) => r.requestIntent, (r: any) => r.requestIntent.project]) {
    const r = structuredClone(request()), object = boundary(r)
    Object.defineProperty(object, 'unexpected', { enumerable: true, get() { effects++; return 1 } })
    expect(() => captureChildBootstrapCaptureRequest(r)).toThrow(TypeError)
  }
  for (const field of ['caller', 'history', 'metadata', 'lineage', 'initial', 'execution']) {
    const c = elaborate() as any
    c[field] = new Proxy(c[field], { get() { effects++; throw new Error('effect') }, ownKeys() { effects++; return [] } })
    expect(() => captureChildBootstrapCore(c)).toThrow(TypeError)
  }
  expect(effects).toBe(0)
})

it('binds the private domains, exact invocation, project and target/source identity', () => {
  const c = core(), r = request(c)
  const hash = (domain: string, value: unknown) => createHash('sha256').update(domain + '\0' + canonicalJsonData(value)).digest('hex')
  expect(r.requestIntent).toEqual({ version: 1, kind: 'child-bootstrap-intent', requestCoreDigest: hash('ih.bootstrap.child.core.v1', c), project: { kind: 'unassigned' } })
  expect(r.invocation.requestDigest).toBe(hash('ih.bootstrap.child.request.v1', r.requestIntent))
  expect(captureChildBootstrapCaptureRequest(r)).toEqual(r)
  for (const project of [{ kind: 'unmanaged' }, { kind: 'unassigned' }, { kind: 'project', projectId: 'p' }] as const) expect(createChildBootstrapRequestIntent(c, project).intent.project).toEqual(project)
  for (const target of ['parent', '../bad', 'a/b', 'a\\b', '', 'a\u007f', 'x'.repeat(257)]) expect(() => captureChildBootstrapCaptureRequest(request(c, target))).toThrow(TypeError)
  const sourceOnly = mutate(c => { c.caller.parentSessionId = ''; delete c.lineage.parentSession; delete c.initial.parentSessionId; c.history = { selection: { kind: 'all' }, source: { kind: 'session', sessionId: 'source' } } })
  expect(() => captureChildBootstrapCaptureRequest(request(sourceOnly, 'source'))).toThrow(TypeError)
  for (const changed of [{ ...r, version: 2 }, { ...r, core: mutate(c => { c.execution.toolNames.reverse() }) }, { ...r, invocation: { ...r.invocation, requestDigest: '0'.repeat(64) } }, { ...r, requestIntent: { ...r.requestIntent, project: { kind: 'unmanaged' } } }]) expect(() => captureChildBootstrapCaptureRequest(changed)).toThrow(TypeError)
  for (const operationId of ['', 'a b', 'a'.repeat(238)]) expect(() => captureChildBootstrapCaptureRequest({ ...r, invocation: { ...r.invocation, operationId } })).toThrow(TypeError)
  for (const createdAt of ['2026-02-30T00:00:00.000Z', '2026-10-23T00:00:00Z']) expect(() => captureChildBootstrapCaptureRequest({ ...r, invocation: { ...r.invocation, createdAt } })).toThrow(TypeError)
})

it('encodes bounded canonical newline reservations and keeps public readers disjoint', () => {
  const value = reservation(), bytes = encodeChildBootstrapReservation(value), parsed = parseChildBootstrapReservation(bytes)
  expect(Buffer.from(bytes).toString()).toBe(canonicalJsonData(value) + '\n'); expect(parsed).toEqual(value); expect(Object.isFrozen(parsed.request.core)).toBe(true)
  for (const invalid of [Buffer.from(bytes).subarray(0, bytes.length - 1), Buffer.from(' ' + Buffer.from(bytes).toString()), Buffer.from(Buffer.from(bytes).toString().replace('"version":1', '"version":2')), Buffer.alloc(262145)]) expect(() => parseChildBootstrapReservation(invalid)).toThrow()
  const huge = core(); huge.caller = { kind: 'task', taskId: 'task', parentSessionId: 'parent', toolCallId: 'x'.repeat(262144) }
  expect(captureChildBootstrapCore(huge)).toEqual(huge); expect(() => encodeChildBootstrapReservation(reservation(request(huge)))).toThrow(TypeError)
  expect(() => captureBootstrapCaptureRequest(value.request)).toThrow(TypeError); expect(() => parseBootstrapCaptureReservation(bytes)).toThrow(TypeError)
  const publicCore = { version: 1 as const, kind: 'session-fork-core' as const, sourceSessionId: 'source', selection: { kind: 'completed' as const }, sourceCapture: 'first-authorized-capture' as const, metadata: {} }
  const { intent, requestDigest } = createBootstrapRequestIntent(publicCore, { kind: 'unassigned' })
  expect(canonicalJsonData(publicCore)).toBe('{"kind":"session-fork-core","metadata":{},"selection":{"kind":"completed"},"sourceCapture":"first-authorized-capture","sourceSessionId":"source","version":1}')
  expect(intent).toEqual({ version: 1, requestCoreDigest: '6cbb0379c49070edd0df50deef4942a99f934fef2cacebe9d907aaef407239b1', project: { kind: 'unassigned' } })
  expect(requestDigest).toBe('15a8b2aebd404a3ae50f9f155b2d19a6fbbb7e0e60bd2b00718946bf58163f6e')
  const publicRequest = { invocation: { ...value.request.invocation, requestDigest }, core: publicCore, requestIntent: intent }
  const publicBytes = encodeBootstrapCaptureReservation({ version: 1, kind: 'semantic-bootstrap-capture', request: publicRequest })
  expect(Buffer.from(publicBytes).toString()).toBe('{"kind":"semantic-bootstrap-capture","request":{"core":{"kind":"session-fork-core","metadata":{},"selection":{"kind":"completed"},"sourceCapture":"first-authorized-capture","sourceSessionId":"source","version":1},"invocation":{"createdAt":"2026-10-23T00:00:00.000Z","operationId":"op","requestDigest":"15a8b2aebd404a3ae50f9f155b2d19a6fbbb7e0e60bd2b00718946bf58163f6e","targetSessionId":"target","version":1},"requestIntent":{"project":{"kind":"unassigned"},"requestCoreDigest":"6cbb0379c49070edd0df50deef4942a99f934fef2cacebe9d907aaef407239b1","version":1}},"version":1}\n')
  expect(parseBootstrapCaptureReservation(publicBytes).request).toEqual(publicRequest)
  expect(() => captureChildBootstrapCore(publicCore)).toThrow(TypeError)
  expect(() => captureChildBootstrapCaptureRequest(publicRequest)).toThrow(TypeError); expect(() => parseChildBootstrapReservation(publicBytes)).toThrow(TypeError)
  const publicStage = buildBootstrapHeader({ ...payload(), invocation: publicRequest.invocation })
  expect(createHash('sha256').update(publicStage.operation.stageBytes).digest('hex')).toBe('e2f221239bf3bd02944c1a50d864f92bcc55703fc9c7cfc9e2ce3fb672f58e8b')
  expect(Buffer.from(publicStage.operation.stageBytes).toString().endsWith('\n')).toBe(true)
  expect(parseBootstrapHeaderStage(publicStage.operation.stageBytes)).toEqual(publicStage.stage)
})

it('commits the exact existing admitted event and original tuple without imposing a prompt-size limit', () => {
  const p = payload(), e = initialAdmission(p)!
  expect(childInitialCommitment(p)).toEqual({ inputId: p.initial!.inputId, digest: bootstrapInitialInputDigest(e, p.initial!.startedAt, p.initial!.expiresAt), startedAt: p.initial!.startedAt, expiresAt: p.initial!.expiresAt, ...(p.initial!.parentSessionId === undefined ? {} : { parentSessionId: p.initial!.parentSessionId }) })
  const original = childInitialCommitment(p)
  for (const field of ['text', 'inputId', 'parentSessionId', 'startedAt', 'expiresAt'] as const) {
    const changed = payload()
    if (field === 'text' || field === 'inputId') changed.initial![field] += 'changed'
    else if (field === 'parentSessionId') { changed.initial!.parentSessionId = 'other'; changed.lineage.parentSession = 'other' }
    else changed.initial![field]++
    expect(childInitialCommitment(changed).digest).not.toBe(original.digest)
  }
  const long = payload(); long.initial!.text = '😀'.repeat(70000)
  expect(captureBootstrapRequest(long).initial!.text).toBe(long.initial!.text)
  const commitment = childInitialCommitment(long), c = core(); c.initial = commitment
  const encoded = encodeChildBootstrapReservation(reservation(request(c)))
  expect(encoded.length).toBeLessThan(3000); expect(Buffer.from(encoded).toString()).not.toContain(long.initial!.text)
  expect(commitment.digest).toBe(bootstrapInitialInputDigest(initialAdmission(long)!, 0, 10)); expect(Object.isFrozen(commitment)).toBe(true)
  const noParent = payload(); delete noParent.lineage.parentSession; delete noParent.initial!.parentSessionId
  expect(Object.hasOwn(childInitialCommitment(noParent), 'parentSessionId')).toBe(false)
  const missing = payload(); delete missing.initial; expect(() => childInitialCommitment(missing)).toThrow(TypeError)
  let effects = 0
  for (const change of [(p: any) => { p.initial.parentSessionId = undefined }, (p: any) => { p.initial.startedAt = -1 }, (p: any) => { p.initial.expiresAt = 0 }, (p: any) => { p.initial.text = '' },
    (p: any) => { p.initial = new Proxy(p.initial, { get() { effects++; return 0 } }) }, (p: any) => { Object.defineProperty(p.initial, 'text', { enumerable: true, get() { effects++; return 'changed' } }) }]) {
    const malformed = payload(); change(malformed); expect(() => childInitialCommitment(malformed)).toThrow(TypeError)
  }
  expect(effects).toBe(0)
  const { stage, operation } = buildBootstrapHeader(p)
  expect(parseBootstrapHeaderStage(operation.stageBytes)).toEqual(stage)
  expect(stage.initial).toEqual({ inputId: original.inputId, digest: original.digest, startedAt: 0, expiresAt: 10 })
})
