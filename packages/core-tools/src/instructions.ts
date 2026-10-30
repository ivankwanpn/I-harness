import type { AcceptedInstructionCall, CapturedToolCall, InstructionBatchEntry, InstructionCellLease, InstructionCellOrigin, NativeMutation, NativePlan, PreparedCall, ToolExec, ToolRegistry } from './types.ts'
import { assertResultPrepared } from './registry/result-finalization.ts'
import { AsyncLocalStorage } from 'node:async_hooks'

const captureOwners = new WeakMap<CapturedToolCall, ToolRegistry>()
export function registerCaptureOwner(capture: CapturedToolCall, registry: ToolRegistry): void { captureOwners.set(capture, registry) }
export function capturedToolRegistry(capture: CapturedToolCall): ToolRegistry {
  const owner = capture && captureOwners.get(capture)
  if (!owner) throw new Error('Foreign tool capture')
  return owner
}

const failures = new WeakSet<object>()
const replans = new WeakSet<object>()
export interface InstructionReplanData { readonly code: 'INSTRUCTIONS_REPLAN_REQUIRED'; readonly currentFingerprint: string; readonly reason: 'missing-origin' | 'unseen-rules' | 'changed-dependency' | 'unavailable' | 'mixed-mutation' | 'revoked'; readonly splitRequired?: true; readonly applied?: readonly string[]; readonly notApplied?: readonly string[]; readonly effectsUnknown?: readonly string[] }
function boundedReplan(data: InstructionReplanData): InstructionReplanData {
  if (data.code !== 'INSTRUCTIONS_REPLAN_REQUIRED' || typeof data.currentFingerprint !== 'string' || data.currentFingerprint.length > 256 || !['missing-origin', 'unseen-rules', 'changed-dependency', 'unavailable', 'mixed-mutation', 'revoked'].includes(data.reason) || data.splitRequired !== undefined && data.splitRequired !== true) throw new TypeError('Invalid instruction replan')
  let total = 0
  const copy = (value: readonly string[] | undefined) => {
    if (value === undefined) return undefined
    if (!Array.isArray(value) || value.length > 1024 || (total += value.length) > 1024 || value.some(path => typeof path !== 'string' || path.length > 4096)) throw new TypeError('Instruction replan effect limit exceeded')
    return Object.freeze([...value])
  }
  const applied = copy(data.applied), notApplied = copy(data.notApplied), effectsUnknown = copy(data.effectsUnknown)
  return Object.freeze({ code: data.code, currentFingerprint: data.currentFingerprint, reason: data.reason, ...(data.splitRequired ? { splitRequired: true as const } : {}), ...(applied ? { applied } : {}), ...(notApplied ? { notApplied } : {}), ...(effectsUnknown ? { effectsUnknown } : {}) })
}
export class InstructionReplanError extends Error {
  readonly code = 'INSTRUCTIONS_REPLAN_REQUIRED' as const
  readonly data: InstructionReplanData
  constructor(data: InstructionReplanData) { super('Instructions changed; a new model request is required'); this.data = boundedReplan(data); replans.add(this) }
}
export function instructionReplan(data: InstructionReplanData): InstructionReplanError { return new InstructionReplanError(data) }
export function isInstructionReplan(error: unknown): error is InstructionReplanError { return typeof error === 'object' && error !== null && replans.has(error) }
export class NativePlanValidationError extends Error {
  readonly output: Readonly<{ error: string; code: string; reason_truncated?: true }>
  constructor(output: Readonly<{ error: string; code: string; reason_truncated?: true }>) {
    if (!output || typeof output.error !== 'string' || typeof output.code !== 'string') throw new TypeError('Invalid native plan failure')
    super(output.error)
    this.output = Object.freeze({ error: output.error, code: output.code, ...(output.reason_truncated === true ? { reason_truncated: true as const } : {}) })
    failures.add(this)
  }
}
export function nativePlanValidationFailure(output: Readonly<{ error: string; code: string; reason_truncated?: true }>): NativePlanValidationError { return new NativePlanValidationError(output) }
export function isNativePlanValidationError(error: unknown): error is NativePlanValidationError { return typeof error === 'object' && error !== null && failures.has(error) }

const executions = new WeakMap<ToolExec, { plan: NativePlan; mutation: NativeMutation }>()
const registeredExecs = new WeakSet<ToolExec>()
export function registerInstructionExec(exec: ToolExec): void { registeredExecs.add(exec) }
const dispositions = new WeakMap<ToolExec, InstructionReplanData>()
const cellRetainers = new WeakMap<ToolExec, (cellId: string, request: object) => InstructionCellLease | undefined>()
const cells = new WeakMap<InstructionCellOrigin, { bind: InstructionCellLease['bind']; preflight: InstructionCellLease['preflight']; release: InstructionCellLease['release']; released: boolean; flight?: Promise<void> }>()
const cellRequests = new WeakMap<object, { origin: AcceptedInstructionCall; capture: CapturedToolCall; cellId: string }>()
const bodyContext = new AsyncLocalStorage<{ exec: ToolExec; active: boolean }>()
export async function runInstructionBody<T>(exec: ToolExec, body: () => Promise<T>): Promise<T> {
  const scope = { exec, active: true }
  try { return await bodyContext.run(scope, body) } finally { scope.active = false }
}
export function isOriginalInstructionCellRequest(request: object, origin: AcceptedInstructionCall, capture: CapturedToolCall, cellId: string): boolean {
  const actual = request && cellRequests.get(request)
  return !!actual && actual.origin === origin && actual.capture === capture && actual.cellId === cellId
}
function method<T extends (...args: any[]) => any>(owner: object, name: string): T {
  for (let object: object | null = owner; object; object = Object.getPrototypeOf(object)) {
    const descriptor = Object.getOwnPropertyDescriptor(object, name)
    if (descriptor) { if ('value' in descriptor && typeof descriptor.value === 'function') return descriptor.value.bind(owner) as T; break }
  }
  throw new TypeError(`Invalid instruction cell ${name} capability`)
}
export function bindInstructionCellRetainer(exec: ToolExec, origin: AcceptedInstructionCall, capture: CapturedToolCall, retain: (cellId: string, request: object) => InstructionCellLease | undefined): void {
  if (cellRetainers.has(exec)) throw new Error('Instruction cell retainer already bound')
  cellRetainers.set(exec, (cellId, request) => { cellRequests.set(request, { origin, capture, cellId }); try { return retain(cellId, request) } finally { cellRequests.delete(request) } })
}
export function retainInstructionCell(exec: ToolExec, cellId: string): InstructionCellOrigin | undefined {
  if (typeof cellId !== 'string' || !cellId) throw new TypeError('Invalid cell identity')
  const retain = cellRetainers.get(exec)
  if (!retain) return undefined
  const scope = bodyContext.getStore()
  if (!scope?.active || scope.exec !== exec) throw new Error('Instruction cell requires the original active tool body')
  cellRetainers.delete(exec)
  const lease = retain(cellId, Object.freeze({}))
  if (!lease) return undefined
  const release = method<InstructionCellLease['release']>(lease, 'release')
  try {
    const origin: InstructionCellOrigin = Object.freeze({ kind: 'instruction-cell-origin' })
    cells.set(origin, { bind: method(lease, 'bind'), preflight: method(lease, 'preflight'), release, released: false })
    return origin
  } catch (error) { void release().catch(() => {}); throw error }
}
export function bindInstructionInvocation(origin: InstructionCellOrigin, invocationId: string, capture: CapturedToolCall): AcceptedInstructionCall {
  const cell = origin && cells.get(origin)
  if (!cell || cell.released || cell.flight) throw new Error('Instruction cell unavailable')
  return cell.bind(invocationId, capture)
}
export function preflightInstructionInvocations(origin: InstructionCellOrigin, entries: readonly InstructionBatchEntry[], signal?: AbortSignal): Promise<void> {
  const cell = origin && cells.get(origin)
  if (!cell || cell.released || cell.flight) return Promise.reject(new Error('Instruction cell unavailable'))
  return cell.preflight(entries, signal)
}
export function releaseInstructionCell(origin: InstructionCellOrigin): Promise<void> {
  const cell = origin && cells.get(origin)
  if (!cell) return Promise.reject(new Error('Foreign instruction cell'))
  if (cell.released) return Promise.resolve()
  if (cell.flight) return cell.flight
  cell.flight = cell.release().then(() => { cell.released = true }, error => { cell.flight = undefined; throw error })
  return cell.flight
}
export function assertNativeInstructions(exec: ToolExec): void { executions.get(exec)?.mutation.assertCurrent() }
export function declareInstructionReplan(exec: ToolExec, error: InstructionReplanError, effects: { applied?: readonly string[]; notApplied?: readonly string[]; effectsUnknown?: readonly string[] } = {}): void {
  if (!registeredExecs.has(exec) || !isInstructionReplan(error)) throw new Error('Instruction replan disposition unavailable')
  dispositions.set(exec, boundedReplan({ ...error.data, ...effects }))
}
export function instructionReplanDisposition(prepared: PreparedCall): InstructionReplanData | undefined { assertResultPrepared(prepared); return dispositions.get(prepared.exec) }
/** Registry-only binding; never derive an executable plan from hook data. */
export function bindNativeExecution(exec: ToolExec, plan: NativePlan, mutation: NativeMutation): void {
  if (executions.has(exec)) throw new Error('Native execution already bound')
  executions.set(exec, { plan, mutation })
}
export function nativeOperation<P>(exec: ToolExec): Readonly<P> {
  const binding = executions.get(exec)
  if (!binding) throw new Error('Native execution unavailable')
  return binding.plan.operation as Readonly<P>
}
export function nativeMutation(exec: ToolExec): NativeMutation {
  const binding = executions.get(exec)
  if (!binding) throw new Error('Native execution unavailable')
  return binding.mutation
}
