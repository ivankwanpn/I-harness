import type { CapturedToolCall, NativeMutation, NativePlan, PreparedCall, ToolExec, ToolRegistry } from './types.ts'
import { assertResultPrepared } from './registry/result-finalization.ts'

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
export class InstructionReplanError extends Error {
  readonly code = 'INSTRUCTIONS_REPLAN_REQUIRED' as const
  readonly data: InstructionReplanData
  constructor(data: InstructionReplanData) { super('Instructions changed; a new model request is required'); this.data = Object.freeze({ ...data }); replans.add(this) }
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
const dispositions = new WeakMap<ToolExec, InstructionReplanData>()
export function assertNativeInstructions(exec: ToolExec): void { executions.get(exec)?.mutation.assertCurrent() }
export function declareInstructionReplan(exec: ToolExec, error: InstructionReplanError, effects: { applied?: readonly string[]; notApplied?: readonly string[]; effectsUnknown?: readonly string[] } = {}): void {
  if (!executions.has(exec) || !isInstructionReplan(error)) throw new Error('Native replan disposition unavailable')
  const copy = (values: readonly string[] | undefined) => values && Object.freeze([...values])
  dispositions.set(exec, Object.freeze({ ...error.data, ...(effects.applied ? { applied: copy(effects.applied) } : {}), ...(effects.notApplied ? { notApplied: copy(effects.notApplied) } : {}), ...(effects.effectsUnknown ? { effectsUnknown: copy(effects.effectsUnknown) } : {}) }))
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
