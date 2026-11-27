import { resolve } from "node:path"
import { createExecutionSupervisor } from "./execution-supervisor.ts"
import { defaultHost } from "./execution-host.ts"
import { createJobServiceWithReservation } from "./jobs/records.ts"
import type { NativeExecService, ExecServiceOptions } from "./index.ts"
import { constructWorkflowStepFactory } from './workflow-step.ts'
export { isWorkflowStepFactory, isWorkflowStepPending } from './workflow-step.ts'
export type { WorkflowStepFactory, OwnedWorkflowStep, StepOwnership } from './workflow-step.ts'
export function createWorkflowStepFactory(pair: ReturnType<typeof createExecServiceWithReservation>, scope: (command: import('./index.ts').ExecCommand) => import('./index.ts').ExecCommand) {
  assertOriginalExecPair(pair)
  return constructWorkflowStepFactory(pair.port, scope)
}
const originalPairs = new WeakMap<object, ReturnType<typeof createJobServiceWithReservation>['pty']>()
export function assertOriginalExecPair(pair: object): void { if(!originalPairs.has(pair))throw new Error('Original Exec construction pair required') }
/** The separate PTY entry borrows the exact same registered native owner. */
export function readOriginalPtyTransport(pair: object) {
  const pty = originalPairs.get(pair)
  if (!pty) throw Error('Original Exec construction pair required')
  return pty
}

export function createExecService(options: ExecServiceOptions = {}): NativeExecService {
  return createExecServiceWithReservation(options).service
}

/** Internal paired constructor; the port is retained by trusted construction. */
export function createExecServiceWithReservation(options: ExecServiceOptions = {}) {
  const host = options.execution ?? defaultHost(resolve(options.workspaceRoot ?? process.cwd()), options.sandbox !== undefined, options.standaloneOwner)
  const supervisor = host.supervisor ?? createExecutionSupervisor()
  const { service, port, pty } = createJobServiceWithReservation(options, host, supervisor)
  const pair = Object.freeze({ service, port })
  originalPairs.set(pair, pty)
  return pair
}
