import { isAbsolute, relative, sep } from 'node:path'
import type { PluginContext } from '@i-harness/core-plugin'
import { CURRENT_FORMAT_VERSION, isManagedFactOwner, type FactOwner, type SessionView } from '@i-harness/core-session'
import type { ToolRegistry } from '@i-harness/core-tools'
import { createExecService } from '@i-harness/exec'
import type { AuthorityState, SandboxMode } from '@i-harness/sandbox'
import type { ManagedDocument, SessionCoordinator } from '@i-harness/session-persistence'
import { taskDocumentOperationsFor } from '@i-harness/session-persistence/internal/task-document-operations'
import { createAssemblyExecutionRuntime, type ExecutionRuntimeOptions } from './execution-runtime.ts'
import { mountOwnedFileSearch } from './owned-file-search.ts'
import { createScopedExec } from './scoped-exec.ts'

export type TaskChildSearchInput = {
  ctx: PluginContext
  tools: ToolRegistry
  session: SessionView
  factOwner: FactOwner
  sessionId: string
  parentSessionId: string
  allowed(name: string): boolean
  retainCleanup(close: () => Promise<void>): void
}

function contains(root: string, path: string): boolean {
  const tail = relative(root, path)
  return tail !== '..' && !tail.startsWith('..' + sep) && !isAbsolute(tail)
}

function workingDirectory(workspace: string, authority: AuthorityState): string {
  if (authority.kind === 'unbound') return authority.workspaceRoot
  if (authority.kind === 'bound') return authority.roots.some(root => contains(root, workspace)) ? workspace : authority.primaryRoot
  throw Error('Original Task child project authority unavailable')
}

function isArchived(header: NonNullable<SessionView['header']>): boolean {
  return Object.getOwnPropertyDescriptor(header, 'archived')?.value === true
}

/** A committed Task child already has an original public writer. Reuse its
 * document proof and the normal scoped execution backend for read-only tools. */
export function captureTaskChildSearch(input: TaskChildSearchInput, coordinator: SessionCoordinator) {
  const { session, factOwner, sessionId, parentSessionId } = input
  const header = session.header
  if (!header || isArchived(header) || sessionId === parentSessionId || session.formatVersion !== CURRENT_FORMAT_VERSION || header.origin !== 'subagent'
      || header.subagentProtocolVersion !== 1 || header.parentSession !== parentSessionId || !header.semanticSeed
      || !isManagedFactOwner(session, factOwner)) throw Error('Original Task child document required')
  const operations = taskDocumentOperationsFor(coordinator)
  if (!operations) throw Error('Original Task child document operations unavailable')
  // This is the existing readiness witness bound to the coordinator's exact
  // open document. It does not reacquire ownership or freeze the append head.
  const witness = operations.parent(factOwner as ManagedDocument)
  const events = session.events
  const seed = header.semanticSeed, floor = header.seedLength ?? 0
  let scanned = floor, recorded: { mode: SandboxMode; seq?: number } | undefined
  const assertCurrent = () => {
    const current = session.header, birth = current?.semanticSeed
    if (factOwner.view !== session || session.events !== events || events.length < scanned || !current || isArchived(current)
        || current.origin !== 'subagent' || current.subagentProtocolVersion !== 1 || current.parentSession !== parentSessionId
        || current.seedLength !== header.seedLength || current.subagentTaskId !== header.subagentTaskId
        || !birth || birth.operationId !== seed.operationId || birth.requestDigest !== seed.requestDigest || birth.manifestDigest !== seed.manifestDigest)
      throw Error('Original Task child document changed')
    operations.assertParentSession(witness, sessionId)
  }
  assertCurrent()
  return Object.freeze({
    assertCurrent,
    policy() {
      assertCurrent()
      // The original owned view is append-only. Inherited policy is outside
      // this child's standing decision, and subsequent reads only check its suffix.
      const end = events.length
      let next = recorded
      for (let ordinal = scanned; ordinal < end; ordinal++) {
        const event = events[ordinal]!
        if (event.type === 'sandbox/mode') next = { mode: event.mode, seq: event.seq }
      }
      assertCurrent()
      if (events.length < end) throw Error('Original Task child policy prefix changed')
      recorded = next
      scanned = end
      return next && { ...next }
    },
    create(options: TaskChildSearchRuntimeOptions) {
      assertCurrent()
      return createOwnedTaskChildSearch(input, options, assertCurrent)
    },
  })
}

type TaskChildSearchRuntimeOptions = {
  workspace: string
  authority(): AuthorityState
  assertParentCurrent(): void
  standing(): { mode: SandboxMode; generation: string }
  execution: Pick<ExecutionRuntimeOptions, 'windowsSandboxBackend' | 'wslExecution' | 'legacyPrivateTempRoot'>
}

function createOwnedTaskChildSearch(input: TaskChildSearchInput, options: TaskChildSearchRuntimeOptions, assertDocumentCurrent: () => void) {
  const workspace = workingDirectory(options.workspace, options.authority())
  let retired = false, closed = false, closing: Promise<void> | undefined
  const current = () => {
    if (retired) throw Error('Original Task child search retired')
    options.assertParentCurrent()
    assertDocumentCurrent()
  }
  const runtime = createAssemblyExecutionRuntime({
    owner: { sessionId: input.sessionId, parentSessionId: input.parentSessionId },
    authority() {
      current()
      const authority = options.authority()
      if (relative(workspace, workingDirectory(options.workspace, authority)) !== '') throw Error('Original Task child search workspace changed')
      return authority
    },
    ownerAvailable: () => !retired,
    standing: options.standing,
    windowsSandboxBackend: options.execution.windowsSandboxBackend,
    wslExecution: options.execution.wslExecution,
    legacyPrivateTempRoot: options.execution.legacyPrivateTempRoot,
  })
  const service = createExecService({ workspaceRoot: workspace, execution: runtime.execution })
  return {
    mount() {
      current()
      mountOwnedFileSearch({
        tools: input.tools, owner: { view: input.session, factOwner: input.factOwner, context: input.ctx, sessionId: input.sessionId },
        workspace, service: createScopedExec(service, workspace, () => undefined), policy: runtime.filesystemPolicy,
        allowed(name) { current(); return input.allowed(name) },
      })
    },
    reconcile: runtime.reconcile,
    close(): Promise<void> {
      retired = true
      if (closed) return Promise.resolve()
      if (closing) return closing
      // Exec owns this exact host and disposes it after settling its jobs.
      const flight = Promise.resolve().then(() => service.dispose()).then(() => { closed = true })
      closing = flight
      void flight.finally(() => { if (closing === flight) closing = undefined }).catch(() => {})
      return flight
    },
  }
}
