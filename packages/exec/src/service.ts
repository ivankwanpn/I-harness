import { resolve } from "node:path"
import { createExecutionSupervisor } from "./execution-supervisor.ts"
import { defaultHost } from "./execution-host.ts"
import { createJobServiceWithReservation } from "./jobs/records.ts"
import type { NativeExecService, ExecServiceOptions } from "./index.ts"

export function createExecService(options: ExecServiceOptions = {}): NativeExecService {
  return createExecServiceWithReservation(options).service
}

/** Internal paired constructor; the port is retained by trusted construction. */
export function createExecServiceWithReservation(options: ExecServiceOptions = {}) {
  const host = options.execution ?? defaultHost(resolve(options.workspaceRoot ?? process.cwd()), options.sandbox !== undefined, options.standaloneOwner)
  const supervisor = host.supervisor ?? createExecutionSupervisor()
  return createJobServiceWithReservation(options, host, supervisor)
}
