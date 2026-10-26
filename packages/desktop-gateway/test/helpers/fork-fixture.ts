import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionCoordinator, createForkSessionController, createForkOperation, readForkOutcome, type ForkOperation } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { managedResultRefs, semanticSeedResultRefs, rewindCuts } from '@i-harness/core-session'
import { createSessionService, createDurableSessionLoader, type SessionServiceOptions } from '@i-harness/session-executor'
import { createSdkServer } from '@i-harness/sdk/server'
import type { RpcMessage } from '@i-harness/sdk'
import { createProjectScopeBroker } from '../../src/project-scope.ts'
import { createNativeContextRuntime } from '../../src/context-runtime.ts'
import { createSessionManagement } from '../../src/session-management.ts'
import { createSessionManagementFence } from '../../src/session-management-fence.ts'
import { createConversationVisibility } from '../../src/session-visibility.ts'
import { createGatewayForkHost } from '../../src/fork-session.ts'
import { createDesktopRouter, createGatewayWrite } from '../../src/router.ts'
import type { DesktopHandlers } from '../../src/types.ts'

/** Actual Gateway owners and route; only provider/backend leaves are controlled. */
export async function createGatewayForkFixture(options: Pick<SessionServiceOptions, 'model' | 'additionalTools' | 'shellRetention'> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ih-c-fork-')), workspace = join(root, 'workspace'), sessions = join(root, 'sessions')
  await mkdir(workspace)
  const coordinator = createSessionCoordinator(createJsonlBackend(sessions), { lock: { enabled: true } }), fence = createSessionManagementFence()
  await coordinator.create({ sessionId: 'source' }); await coordinator.create({ sessionId: 'other' })
  const projects = createProjectScopeBroker(coordinator, workspace)
  const project = { id: 'p', name: 'Project', roots: [workspace], primaryRoot: workspace }
  await projects.configure(project); await projects.bind('source', 'p'); await projects.bind('other', 'p')
  const runtime = await createNativeContextRuntime({ workspace, storageRoot: join(root, 'native'), coordinator,
    projectFor: projects.nativeScopeFor, resultReadScopeFor: projects.resultReadScopeFor, withBindingObservation: projects.withBindingObservation,
    prepareBootstrapInheritance: projects.prepareBootstrapInheritance,
    visibleRefsFor: async id => { const view = runtime.observations.current(id)?.view ?? (await coordinator.snapshot!(id)).session, cuts = rewindCuts(view)
      return [...semanticSeedResultRefs(view), ...view.events.flatMap(event => !cuts.some(cut => event.seq !== undefined && event.seq >= cut.cutFrom && event.seq < cut.markerSeq) ? managedResultRefs(event) : [])] } })
  const service = createSessionService({ ...options, workspace, coordinator, sessionFor: createDurableSessionLoader(coordinator), sessionOperation: fence,
    modelPolicy: 'required', approveAll: true, sandbox: 'danger-full-access', codeMode: { mode: 'off' }, contextOutput: runtime.contextOutput,
    contextOutputSourceFor: runtime.sourceFor, contextOutputLegacyReadObservation: runtime.withLegacyReadObservation, resultReadScopeFor: projects.resultReadScopeFor })
  const management = createSessionManagement(coordinator, service, createConversationVisibility(coordinator), { fence, projectFor: projects.projectFor })
  const host = createGatewayForkHost({ workspace, coordinator, projects, nativeContext: runtime }), controller = createForkSessionController(coordinator, host)
  const handlers: DesktopHandlers = { sessions: management, projects }, frames: RpcMessage[] = [], send = (frame: RpcMessage) => { frames.push(frame) }
  const base = createSdkServer(service, { coordinator, onWrite: createGatewayWrite(send, handlers), prepareForkSession: input => controller.prepare(input), executeForkSession: (input, control) => controller.execute(input, control) })
  const router = createDesktopRouter(base, send, handlers)
  let serial = 0
  const call = async (method: string, params: unknown = {}) => {
    const id = ++serial; await router.handleLine(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    const frame = frames.findLast(frame => 'id' in frame && frame.id === id)
    if (!frame || !('id' in frame) || !('result' in frame)) throw new Error(JSON.stringify(frame))
    return frame.result
  }
  await call('initialize')
  return { root, workspace, sessions, coordinator, projects, project, runtime, service, management, host, controller, base, router, call,
    async prepare(sourceSessionId: string, targetSessionId: string, operationId: string) {
      const prepared = await call('session/fork/prepare', { version: 1, sourceSessionId }) as import('@i-harness/session-persistence').ForkPrepareResult
      if (prepared.kind !== 'prepared') throw new Error('Actual Gateway preparation refused: ' + JSON.stringify(prepared))
      return createForkOperation(prepared.prepared, { operationId, targetSessionId, createdAt: new Date().toISOString() })
    },
    async execute(operation: ForkOperation, mode: 'begin' | 'retry' = 'begin') { return readForkOutcome(await call('session/fork/' + mode, { operation }), operation) },
    async close() { await router.close(); await base.close(); await controller.close(); await service.close(); await runtime.close(); await projects.close(); await coordinator.close() },
  }
}
