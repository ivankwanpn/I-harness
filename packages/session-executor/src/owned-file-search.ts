import { createFsSearchTools } from '@i-harness/fs-search'
import type { Tool, ToolRegistry } from '@i-harness/core-tools'
import { bindPreparedScopedExecLeaf, type ToolExecutionOwnerConfiguration } from '@i-harness/core-tools/internal/scoped-exec-origin'
import type { ExecService } from '@i-harness/exec'
import type { OriginalFilesystemPolicy } from './execution-runtime.ts'

/** Keep the original bounded search runner and put every helper under the
 * same prepared tool invocation and its own standing execution host. */
export function mountOwnedFileSearch(options: {
  tools: ToolRegistry
  owner: ToolExecutionOwnerConfiguration
  workspace: string
  service: ExecService
  policy: OriginalFilesystemPolicy
  allowed?(name: string): boolean
}): void {
  const { tools, owner, workspace, service, policy, allowed } = options
  for (const tool of createFsSearchTools({ exec: service, workspace })) {
    const name = tool.name
    if (allowed && !allowed(name)) continue
    const mounted: Tool = {
      ...tool,
      async execute(args, execution) {
        const assertCurrent = enter(execution)
        const current = () => {
          try { assertCurrent(); return allowed?.(name) !== false }
          catch { return false }
        }
        return policy.withCurrentCaller(current, () => tool.execute(args, execution))
      },
    }
    const enter = bindPreparedScopedExecLeaf(tools, owner, mounted, mounted.execute)
    tools.register(mounted)
  }
}
