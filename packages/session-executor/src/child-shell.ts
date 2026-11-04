import { randomUUID } from 'node:crypto'
import { registerExecWithReservation } from '@i-harness/exec'
import { createShellTools } from '@i-harness/shell'
import type { PluginContext } from '@i-harness/core-plugin'
import type { ToolRegistry } from '@i-harness/core-tools'
import type { ContextOutputService } from '@i-harness/context-output'
import type { ExecExecutionHost } from '@i-harness/exec'
import type { ManagedExecutionAttachment } from '../../session-persistence/src/execution-internal.ts'
import { createExecResultRetention } from './lifecycle/exec-result-retention.ts'
import { receivedExecutionInputsFor } from './lifecycle/execution-inputs.ts'
import { createScopedPrivateExecWithReservation } from './scoped-exec.ts'
import { createChildExecutionDomain } from './host-managed-execution.ts'

export interface ChildShellMount {
  /** Idempotent: disposes the child's exec reservation and releases the child
   * execution acquisition. Also runs when the child context unmounts. */
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
  release(): Promise<void>
}): ChildShellMount {
  const domain = createChildExecutionDomain(options.execution, options.ctx)
  const pair = registerExecWithReservation(options.ctx, {
    workspaceRoot: options.workspace,
    execution: options.host,
    resultRetention: createExecResultRetention(options.output),
  })
  let disposed: Promise<void> | undefined
  const dispose = () => disposed ??= (async () => { pair.service.dispose(); await options.release() })()
  const name = `child-shell-${randomUUID()}`
  try {
    const recipient = receivedExecutionInputsFor(options.execution).execDelivery(domain)
    const scoped = createScopedPrivateExecWithReservation(pair, options.workspace, () => undefined, options.execution, domain, options.ctx, recipient)
    for (const tool of createShellTools({ exec: scoped.service, directEntry: scoped.direct })) options.tools.register(tool)
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