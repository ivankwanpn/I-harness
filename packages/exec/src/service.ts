import { resolve } from "node:path"
import { createExecutionSupervisor } from "./execution-supervisor.ts"
import { defaultHost } from "./execution-host.ts"
import { createJobService } from "./jobs/records.ts"
import type { NativeExecService, ExecServiceOptions } from "./index.ts"

const nativeServices = new WeakSet<object>()
export function isNativeExecService(service: unknown): service is NativeExecService {
  return typeof service === "object" && service !== null && nativeServices.has(service)
}

export function createExecService(options: ExecServiceOptions = {}): NativeExecService {
  const host = options.execution ?? defaultHost(resolve(options.workspaceRoot ?? process.cwd()), options.sandbox !== undefined, options.standaloneOwner)
  const supervisor = host.supervisor ?? createExecutionSupervisor()
  const service = createJobService(options, host, supervisor)
  nativeServices.add(service)
  return service
}
