import type { BootstrapCallerMetadata } from './coordinator/bootstrap-types.ts'
import type { BootstrapInvocation, BootstrapResumeToken } from './coordinator/bootstrap-types.ts'
import type { BootstrapRequestIntent } from './coordinator/bootstrap-intent.ts'

export interface ForkRequestCore {
  version: 1; kind: 'session-fork-core'; sourceSessionId: string;
  selection: { kind: 'completed'; atSeq?: number };
  sourceCapture: 'first-authorized-capture'; metadata: BootstrapCallerMetadata;
}
const invalid = (): never => { throw new TypeError('Invalid fork request core') }
function fields(value: unknown, required: string[], optional: string[] = []): Record<string, any> {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(value as object).some(key => typeof key !== 'string' || !required.includes(key) && !optional.includes(key)) || required.some(key => !Object.hasOwn(descriptors, key))) invalid()
  const result: Record<string, any> = {}
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !('value' in descriptor) || descriptor.value === undefined) invalid()
    result[key] = descriptor.value
  }
  return result
}
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256
/** Browser-only descriptor reader. Node hosts additionally reject proxies. */
export function readForkRequestCore(input: unknown): Readonly<ForkRequestCore> {
  const r = fields(input, ['version', 'kind', 'sourceSessionId', 'selection', 'sourceCapture', 'metadata'])
  if (r.version !== 1 || r.kind !== 'session-fork-core' || r.sourceCapture !== 'first-authorized-capture' || !id(r.sourceSessionId) || /[\\/\u0000-\u001f\u007f]/.test(r.sourceSessionId) || r.sourceSessionId.includes('..')) invalid()
  const selection = fields(r.selection, ['kind'], ['atSeq'])
  if (selection.kind !== 'completed' || selection.atSeq !== undefined && (!Number.isSafeInteger(selection.atSeq) || selection.atSeq < 0)) invalid()
  const metadata = fields(r.metadata, [], ['title', 'workspaceId', 'modelSelection'])
  if (metadata.title !== undefined && (typeof metadata.title !== 'string' || new TextEncoder().encode(metadata.title).length > 32768) || metadata.workspaceId !== undefined && !id(metadata.workspaceId)) invalid()
  if (metadata.modelSelection !== undefined) {
    const m = fields(metadata.modelSelection, ['provider', 'model'], ['protocol', 'reasoningEffort'])
    if (!id(m.provider) || !id(m.model) || m.reasoningEffort !== undefined && !id(m.reasoningEffort) || m.protocol !== undefined && !['openai-completions', 'openai-responses', 'anthropic-messages', 'gemini', 'bedrock'].includes(m.protocol)) invalid()
    metadata.modelSelection = Object.freeze(m)
  }
  return Object.freeze({ version: 1, kind: 'session-fork-core', sourceSessionId: r.sourceSessionId, selection: Object.freeze(selection), sourceCapture: 'first-authorized-capture', metadata: Object.freeze(metadata) }) as Readonly<ForkRequestCore>
}

export interface ForkPrepareRequest { version: 1; sourceSessionId: string; selection?: { kind: 'completed'; atSeq?: number }; metadata?: BootstrapCallerMetadata }
export interface ForkPrepared { version: 1; kind: 'session-fork-prepared'; core: ForkRequestCore; requestIntent: BootstrapRequestIntent; requestDigest: string }
export type ForkPrepareResult = { kind: 'prepared'; prepared: ForkPrepared } | { kind: 'unavailable'; reason: 'unsupported'|'source-unavailable'|'policy'|'unavailable' }
export interface ForkOperation { version: 1; kind: 'session-fork-operation'; prepared: ForkPrepared; invocation: BootstrapInvocation }
export interface ForkCommand { operation: ForkOperation; mode: 'begin'|'retry' }
export type ForkCaptureState = 'uncaptured'|'captured'|'unknown'
export interface ForkReceiptSummary { version: 1; invocation: BootstrapInvocation; manifestDigest: string; seedLength: number; dependencyClosureDigest: string }
export type ForkSuccess = { version: 1; kind: 'ready'|'adopted'; operation: ForkOperation; capture: 'captured'; sessionId: string; seedLength: number; receipt: ForkReceiptSummary; title?: string }
export type ForkNotIssuedReason = 'cancelled'|'stale-source'|'unsupported'|'busy'|'source-unavailable'|'policy'|'unavailable'
export type ForkRefusal = 'conflict'|'nonempty'|'cached-unprepared'|'wrong-view'|'incompatible'|'manifest-invalid'|'target-policy'|'invalid-selection'|'source-unsupported'|'ambiguous-boundary'|'no-completed-boundary'|'straddling-group'|'unsafe-input-component'|'invalid-seed'|'source-changed'|'legacy-anchor-unsupported'
export type ForkOutcome = ForkSuccess
  | { version: 1; kind: 'not-issued'; operation: ForkOperation; capture: ForkCaptureState; reason: ForkNotIssuedReason }
  | { version: 1; kind: 'blocked'; operation: ForkOperation; capture: ForkCaptureState; reason: 'unknown'|'payload-required'|'dependency-unavailable'|'source-changed'; token: BootstrapResumeToken }
  | { version: 1; kind: 'refused'; operation: ForkOperation; capture: ForkCaptureState; reason: ForkRefusal }
export interface ForkHostErrorData { version: 1; kind: 'session-fork-error'; operation: ForkOperation; capture: ForkCaptureState; reason: 'host-unavailable'|'cleanup-incomplete'|'internal'; lastOutcome?: ForkOutcome }

const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const safeId = (value: unknown): value is string => id(value) && !/[\\/\u0000-\u001f\u007f]/.test(value) && !value.includes('..')
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
function invocation(input: unknown): BootstrapInvocation {
  const r = fields(input, ['version','operationId','targetSessionId','createdAt','requestDigest'])
  if (r.version !== 1 || typeof r.operationId !== 'string' || !/^[\x21-\x7e]{1,237}$/.test(r.operationId)
    || !safeId(r.targetSessionId) || !digest(r.requestDigest) || typeof r.createdAt !== 'string'
    || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(r.createdAt)
    || !Number.isFinite(Date.parse(r.createdAt)) || new Date(r.createdAt).toISOString() !== r.createdAt) invalid()
  return Object.freeze({ version: 1, operationId: r.operationId, targetSessionId: r.targetSessionId, createdAt: r.createdAt, requestDigest: r.requestDigest })
}
function prepared(input: unknown): ForkPrepared {
  const r = fields(input, ['version','kind','core','requestIntent','requestDigest'])
  if (r.version !== 1 || r.kind !== 'session-fork-prepared' || !digest(r.requestDigest)) invalid()
  const core = readForkRequestCore(r.core), intent = fields(r.requestIntent, ['version','requestCoreDigest','project'])
  if (intent.version !== 1 || !digest(intent.requestCoreDigest)) invalid()
  const project = fields(intent.project, ['kind'], ['projectId'])
  if (project.kind === 'project') { if (!id(project.projectId) || /[\u0000-\u001f\u007f]/.test(project.projectId)) invalid() }
  else if (!['unmanaged','unassigned'].includes(project.kind) || Object.hasOwn(project, 'projectId')) invalid()
  return Object.freeze({ version: 1, kind: 'session-fork-prepared', core,
    requestIntent: Object.freeze({ version: 1, requestCoreDigest: intent.requestCoreDigest, project: Object.freeze(project) }) as BootstrapRequestIntent, requestDigest: r.requestDigest })
}
export function readForkPrepareRequest(input: unknown): ForkPrepareRequest {
  const r = fields(input, ['version','sourceSessionId'], ['selection','metadata'])
  if (r.version !== 1) invalid()
  const core = readForkRequestCore({ version: 1, kind: 'session-fork-core', sourceSessionId: r.sourceSessionId,
    selection: r.selection === undefined ? { kind: 'completed' } : r.selection, sourceCapture: 'first-authorized-capture', metadata: r.metadata === undefined ? {} : r.metadata })
  return Object.freeze({ version: 1, sourceSessionId: core.sourceSessionId,
    ...(r.selection === undefined ? {} : { selection: core.selection }), ...(r.metadata === undefined ? {} : { metadata: core.metadata }) })
}
export function readForkPrepareResult(input: unknown): ForkPrepareResult {
  const r = fields(input, ['kind'], ['prepared','reason'])
  if (r.kind === 'prepared') { fields(input, ['kind','prepared']); return Object.freeze({ kind: 'prepared', prepared: prepared(r.prepared) }) }
  fields(input, ['kind','reason'])
  if (r.kind !== 'unavailable' || !['unsupported','source-unavailable','policy','unavailable'].includes(r.reason)) invalid()
  return Object.freeze({ kind: 'unavailable', reason: r.reason })
}
export function readForkOperation(input: unknown): ForkOperation {
  const r = fields(input, ['version','kind','prepared','invocation'])
  if (r.version !== 1 || r.kind !== 'session-fork-operation') invalid()
  const p = prepared(r.prepared), i = invocation(r.invocation)
  if (i.requestDigest !== p.requestDigest || i.targetSessionId === p.core.sourceSessionId) invalid()
  return Object.freeze({ version: 1, kind: 'session-fork-operation', prepared: p, invocation: i })
}
export function createForkOperation(p: ForkPrepared, identity: { operationId: string; targetSessionId: string; createdAt: string }): ForkOperation {
  fields(identity, ['operationId','targetSessionId','createdAt'])
  return readForkOperation({ version: 1, kind: 'session-fork-operation', prepared: p,
    invocation: { version: 1, ...identity, requestDigest: p.requestDigest } })
}
export function readForkCommand(input: unknown): ForkCommand {
  const r = fields(input, ['operation','mode'])
  if (r.mode !== 'begin' && r.mode !== 'retry') invalid()
  return Object.freeze({ operation: readForkOperation(r.operation), mode: r.mode })
}
const notIssued = ['cancelled','stale-source','unsupported','busy','source-unavailable','policy','unavailable']
const refused = ['conflict','nonempty','cached-unprepared','wrong-view','incompatible','manifest-invalid','target-policy','invalid-selection','source-unsupported','ambiguous-boundary','no-completed-boundary','straddling-group','unsafe-input-component','invalid-seed','source-changed','legacy-anchor-unsupported']
export function readForkOutcome(input: unknown, expectedOperation: ForkOperation): ForkOutcome {
  const r = fields(input, ['version','kind','operation','capture'], ['reason','token','sessionId','seedLength','receipt','title'])
  const operation = readForkOperation(r.operation), expected = readForkOperation(expectedOperation)
  if (r.version !== 1 || !same(operation, expected) || !['uncaptured','captured','unknown'].includes(r.capture)) invalid()
  const base = { version: 1 as const, operation, capture: r.capture }
  if (r.kind === 'ready' || r.kind === 'adopted') {
    fields(input, ['version','kind','operation','capture','sessionId','seedLength','receipt'], ['title'])
    const receipt = fields(r.receipt, ['version','invocation','manifestDigest','seedLength','dependencyClosureDigest'])
    const inv = invocation(receipt.invocation)
    if (r.capture !== 'captured' || r.sessionId !== operation.invocation.targetSessionId || !count(r.seedLength)
      || receipt.version !== 1 || receipt.seedLength !== r.seedLength || !same(inv, operation.invocation)
      || !digest(receipt.manifestDigest) || !digest(receipt.dependencyClosureDigest) || r.title !== operation.prepared.core.metadata.title) invalid()
    return Object.freeze({ ...base, kind: r.kind, sessionId: r.sessionId, seedLength: r.seedLength,
      receipt: Object.freeze({ version: 1, invocation: inv, manifestDigest: receipt.manifestDigest, seedLength: receipt.seedLength, dependencyClosureDigest: receipt.dependencyClosureDigest }),
      ...(r.title === undefined ? {} : { title: r.title }) }) as ForkSuccess
  }
  fields(input, ['version','kind','operation','capture','reason'], r.kind === 'blocked' ? ['token'] : [])
  if (r.kind === 'not-issued' && notIssued.includes(r.reason) || r.kind === 'refused' && refused.includes(r.reason)) return Object.freeze({ ...base, kind: r.kind, reason: r.reason }) as ForkOutcome
  if (r.kind !== 'blocked' || !['unknown','payload-required','dependency-unavailable','source-changed'].includes(r.reason)) invalid()
  const token = fields(r.token, ['version','invocation','phase'], ['manifest','manifestDigest']), inv = invocation(token.invocation)
  if (token.version !== 1 || !same(inv, operation.invocation)) invalid()
  if (token.manifest === 'unknown') { fields(r.token, ['version','invocation','phase','manifest']); if (token.phase !== 'header') invalid() }
  else { fields(r.token, ['version','invocation','phase','manifestDigest']); if (!digest(token.manifestDigest) || !['header','dependencies','seed','completion'].includes(token.phase)) invalid() }
  return Object.freeze({ ...base, kind: 'blocked', reason: r.reason, token: Object.freeze({ ...token, invocation: inv }) }) as ForkOutcome
}
export function readForkHostErrorData(input: unknown, expectedOperation: ForkOperation): ForkHostErrorData {
  const r = fields(input, ['version','kind','operation','capture','reason'], ['lastOutcome'])
  const operation = readForkOperation(r.operation)
  if (r.version !== 1 || r.kind !== 'session-fork-error' || !same(operation, readForkOperation(expectedOperation))
    || !['uncaptured','captured','unknown'].includes(r.capture) || !['host-unavailable','cleanup-incomplete','internal'].includes(r.reason)) invalid()
  const lastOutcome = r.lastOutcome === undefined ? undefined : readForkOutcome(r.lastOutcome, operation)
  if (lastOutcome?.capture === 'captured' && r.capture !== 'captured') invalid()
  return Object.freeze({ version: 1, kind: 'session-fork-error', operation, capture: r.capture, reason: r.reason,
    ...(lastOutcome === undefined ? {} : { lastOutcome }) })
}
export class ForkOperationError extends Error {
  readonly operation: ForkOperation
  readonly kind: 'outcome'|'transport'|'protocol'|'host'|'cleanup'
  readonly outcome?: ForkOutcome
  readonly hostError?: ForkHostErrorData
  constructor(operation: ForkOperation, kind: ForkOperationError['kind'], options: { cause?: unknown; outcome?: ForkOutcome; hostError?: ForkHostErrorData } = {}) {
    super('Session fork ' + kind, { cause: options.cause }); this.name = 'ForkOperationError'
    this.operation = operation; this.kind = kind; this.outcome = options.outcome; this.hostError = options.hostError
  }
}
export class ForkPreparationError extends Error {
  constructor(readonly kind: 'unavailable'|'transport'|'protocol', readonly result?: Extract<ForkPrepareResult, { kind: 'unavailable' }>, options?: ErrorOptions) {
    super('Session fork preparation ' + kind, options); this.name = 'ForkPreparationError'
  }
}
