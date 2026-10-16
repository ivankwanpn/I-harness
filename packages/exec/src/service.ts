import { resolve } from "node:path"
import { createExecutionSupervisor } from "./execution-supervisor.ts"
import { defaultHost } from "./execution-host.ts"
import { createJobService } from "./jobs/records.ts"
import type { ExecService, ExecServiceOptions } from "./index.ts"

export function createExecService(options: ExecServiceOptions = {}): ExecService {
  const host = options.execution ?? defaultHost(resolve(options.workspaceRoot ?? process.cwd()), options.sandbox !== undefined, options.standaloneOwner)
  const supervisor = host.supervisor ?? createExecutionSupervisor()
  return createJobService(options, host, supervisor)
}
