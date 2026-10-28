import type { NativeMutation, NativePlan, ToolExec } from './types.ts'

const failures = new WeakSet<object>()
export class NativePlanValidationError extends Error {
  readonly output: Readonly<{ error: string; code: string }>
  constructor(output: Readonly<{ error: string; code: string }>) {
    if (!output || typeof output.error !== 'string' || typeof output.code !== 'string') throw new TypeError('Invalid native plan failure')
    super(output.error)
    this.output = Object.freeze({ error: output.error, code: output.code })
    failures.add(this)
  }
}
export function nativePlanValidationFailure(output: Readonly<{ error: string; code: string }>): NativePlanValidationError { return new NativePlanValidationError(output) }
export function isNativePlanValidationError(error: unknown): error is NativePlanValidationError { return typeof error === 'object' && error !== null && failures.has(error) }

const executions = new WeakMap<ToolExec, { plan: NativePlan; mutation: NativeMutation }>()
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
