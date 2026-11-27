import { randomUUID } from 'node:crypto'
import { registerExecWithReservation } from '@i-harness/exec'
import { createShellTools } from '@i-harness/shell'
import type { PluginContext } from '@i-harness/core-plugin'
import type { ToolRegistry } from '@i-harness/core-tools'
import type { ContextOutputService } from '@i-harness/context-output'
import type { ExecExecutionHost } from '@i-harness/exec'
import type { FactOwner, SessionView } from '@i-harness/core-session'
import type { ManagedExecutionAttachment } from '../../session-persistence/src/execution-internal.ts'
import { createExecResultRetention } from './lifecycle/exec-result-retention.ts'
import { receivedExecutionInputsFor } from './lifecycle/execution-inputs.ts'
import { createScopedPrivateExecWithReservation } from './scoped-exec.ts'
import { createChildExecutionDomain } from './host-managed-execution.ts'
import { originalFilesystemPolicyFor } from './execution-runtime.ts'
import { mountOwnedFileSearch } from './owned-file-search.ts'

export interface ChildShellMount {
  /** Stops the child's Exec service before releasing the execution acquisition.
   * Concurrent calls join, and a failure can retry the unfinished stage. */
  dispose(): Promise<void>
}

/**
 * Mount the child's OWN shell tools (child-exec L2): a private exec reservation
 * over the host-built child execution host, bound to the child's execution
 * attachment and domain, with a direct entry keyed by the child plugin context.
 * The parent's context-bound shell tools cannot run in a child context.
 */
export function mountChildShellTools(options: {
  ctx: PluginContext
  tools: ToolRegistry
  workspace: string
  execution: ManagedExecutionAttachment
  host: ExecExecutionHost
  output?: ContextOutputService
  allowedTools?: readonly string[]
  isToolAllowed?(name: string): boolean
  searchOwner?: { session: SessionView; factOwner: FactOwner }
  release(): Promise<void>
}): ChildShellMount {
  const domain = createChildExecutionDomain(options.execution, options.ctx)
  const pair = registerExecWithReservation(options.ctx, {
    workspaceRoot: options.workspace,
    execution: options.host,
    resultRetention: createExecResultRetention(options.output),
  })
  let stopped = false
  let disposal: Promise<void> | undefined
  function dispose(): Promise<void> {
    if (disposal) return disposal
    // Publish the flight before either cleanup callback can reenter dispose.
    const attempt = Promise.resolve().then(async () => {
      if (!stopped) {
        await pair.service.dispose()
        stopped = true
      }
      await options.release()
    })
    disposal = attempt
    void attempt.catch(() => { if (disposal === attempt) disposal = undefined })
    return attempt
  }
  const name = `child-shell-${randomUUID()}`
  try {
    const recipient = receivedExecutionInputsFor(options.execution).execDelivery(domain)
    const scoped = createScopedPrivateExecWithReservation(pair, options.workspace, () => undefined, options.execution, domain, options.ctx, recipient)
    const allowed = (tool: string) => options.allowedTools?.includes(tool) !== false && options.isToolAllowed?.(tool) !== false
    for (const tool of createShellTools({ exec: scoped.service, directEntry: scoped.direct })) {
      if (allowed(tool.name)) options.tools.register(tool)
    }
    const policy = originalFilesystemPolicyFor(options.host, options.execution)
    const owner = options.searchOwner
    if (policy && owner) mountOwnedFileSearch({
      workspace: options.workspace, tools: options.tools, service: scoped.service, policy, allowed,
      owner: { view: owner.session, factOwner: owner.factOwner, context: options.ctx, sessionId: domain.sessionId },
    })
    options.ctx.mount({ name, mount() {}, async unmount() { await dispose() } })
    return Object.freeze({ dispose })
  } catch (error) {
    options.ctx.unmount(name).catch(() => {})
    // Release the reservation only; the caller owns the child execution
    // acquisition and host cleanups (it may need to run them exactly once).
    pair.service.dispose()
    throw error
  }
}
