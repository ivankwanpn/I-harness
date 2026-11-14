import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { committedFactSeqs, managedResultRefs, semanticSeedResultRefs, rewindCuts } from '@i-harness/core-session'
import { executeToolCalls } from '../../../core-agent/src/index.ts'
import { createForkOperation, createForkSessionController, type SessionCoordinator } from '@i-harness/session-persistence'
import type { createSessionAssembly, SessionProjectContext } from '@i-harness/session-executor'
import { createProjectScopeBroker } from '../../src/project-scope.ts'
import { createNativeContextRuntime } from '../../src/context-runtime.ts'
import { createGatewayForkHost } from '../../src/fork-session.ts'
import { createSelectedResultsIntent, readSelectedResultsCore, readSelectedResultsOperation } from '../../../session-persistence/src/selected-results-fork-contract.ts'
import { inspectColdSelectedTarget, beginColdSelectedFinalization } from '../../../session-persistence/src/selected-source-owner.ts'
import { captureSelectedResultsRoute } from '../../../session-persistence/src/coordinator/selected-results-route.ts'

/** The original managed call, action and settlement source all reach shipping
 * preparation. No fixture constructs a prepared call or borrows parent grants. */
export async function dispatchOwned(assembly: Awaited<ReturnType<typeof createSessionAssembly>>, name: string, args: unknown) {
  const action = assembly.factOwner.beginAction(), callId = randomUUID()
  try {
    const admission = await action.facts.tools.call({ type: 'tool/call', name, args, callId })
    const [eventSeq] = committedFactSeqs(admission)
    await executeToolCalls(assembly.ctx, assembly.session, assembly.tools, [{ name, args, callId, eventSeq }], {
      sessionId: assembly.sessionId, maxParallel: 1, facts: action.facts.tools,
      registerFactSource: drain => action.registerSettlementSource(drain), assertFactOpen: action.assertOpen,
    })
    const result = assembly.session.events.findLast(event => event.type === 'tool/result' && event.callId === callId)
    if (result?.type !== 'tool/result' || !result.envelope || result.envelope.retention.kind !== 'inline') throw new Error('Expected the actual bounded inline dispatch result')
    if (result.envelope.execution.outcome !== 'succeeded') throw new Error(JSON.stringify(result.envelope))
    console.info(JSON.stringify({ fixture: 'c67-owned-dispatch', sessionId: assembly.sessionId, name, callId, eventSeq, admission, resultSeq: result.seq, resultBytes: result.envelope.retention.encodedBytes }))
    return result.envelope.retention.value
  } finally { action.finish() }
}

/** Production Gateway fork composition with genuine broker and result owners. */
export async function createNativeConsumerOwners(coordinator: SessionCoordinator, root: string, project?: SessionProjectContext) {
  const projects = createProjectScopeBroker(coordinator, root)
  if (project) await projects.configure(project)
  const runtime = await createNativeContextRuntime({ workspace: root, storageRoot: join(root, 'native'), coordinator,
    projectFor: projects.nativeScopeFor, resultReadScopeFor: projects.resultReadScopeFor,
    withBindingObservation: projects.withBindingObservation, prepareBootstrapInheritance: projects.prepareBootstrapInheritance,
    prepareTaskChildInheritance: projects.prepareTaskChildInheritance,
    retainSelectedProjectRead: projects.retainSelectedBindingRead.bind(projects),
    prepareSelectedInheritance: projects.prepareSelectedInheritance.bind(projects),
    acquireColdTargetPolicy: projects.acquireColdTargetPolicy.bind(projects),
    visibleRefsFor: async id => {
      const observation = runtime.observations.current(id), view = observation?.kind === 'public' ? observation.view : (await coordinator.snapshot!(id)).session, cuts = rewindCuts(view)
      return [...semanticSeedResultRefs(view), ...view.events.flatMap(event => !cuts.some(cut => event.seq !== undefined && event.seq >= cut.cutFrom && event.seq < cut.markerSeq)
        ? [...managedResultRefs(event), ...(event.type === 'context/result-ref' ? [event.ref] : [])] : [])]
    },
  })
  const confirmManaged = runtime.contextOutput.confirmSeedDependencies.bind(runtime.contextOutput)
  runtime.contextOutput.confirmSeedDependencies = async (...args) => {
    const outcome = await confirmManaged(...args)
    console.info(JSON.stringify({ fixture: 'c67-managed-transfer', request: args[1], outcome }))
    return outcome
  }
  const confirmLegacy = runtime.contextOutput.confirmLegacyForkTransfer.bind(runtime.contextOutput)
  runtime.contextOutput.confirmLegacyForkTransfer = async (...args) => {
    const outcome = await confirmLegacy(...args)
    console.info(JSON.stringify({ fixture: 'c67-legacy-transfer', request: args[1], outcome }))
    return outcome
  }
  const controller = createForkSessionController(coordinator, createGatewayForkHost({ workspace: root, coordinator, projects, nativeContext: runtime }))
  return { runtime, projects,
    async forkSelected(sourceSessionId: string) {
      const scope = await projects.resultReadScopeFor(sourceSessionId)
      if (!scope) throw new Error('Original selected project scope unavailable')
      const projectId = scope().projectId
      const core = readSelectedResultsCore({ version: 2, kind: 'session-fork-core', sourceSessionId,
        selection: { kind: 'completed' }, sourceCapture: 'first-authorized-capture', metadata: {}, results: 'selected-results-v1' })
      const { intent, requestDigest } = createSelectedResultsIntent(core, projectId ? { kind: 'project', projectId } : { kind: 'unassigned' })
      const targetSessionId = randomUUID()
      const operation = readSelectedResultsOperation({ version: 2, kind: 'session-fork-operation',
        prepared: { version: 2, kind: 'session-fork-prepared', core, requestIntent: intent, requestDigest },
        invocation: { version: 1, operationId: randomUUID(), targetSessionId, createdAt: new Date().toISOString(), requestDigest } })
      const holder = runtime.createSelectedSourceHolder(operation)
      try {
        const captured = await holder.captureFirst()
        if (captured.kind !== 'captured') throw new Error('Original selected capture refused: ' + JSON.stringify(captured))
        const outcome = await holder.publishWarm()
        if (outcome.kind !== 'ready') throw new Error('Original selected publication refused: ' + JSON.stringify(outcome))
        return { sessionId: targetSessionId, operation }
      } finally { await holder.close() }
    },
    async restoreSelected(operation: Parameters<typeof readSelectedResultsOperation>[0]) {
      const original=readSelectedResultsOperation(operation)
      const route=captureSelectedResultsRoute({protocol:'public-results-v1',request:{invocation:original.invocation,core:original.prepared.core,requestIntent:original.prepared.requestIntent}})
      const inspected=await inspectColdSelectedTarget(coordinator,route)
      if(inspected.kind!=='qualification-required')throw Error('Original cold selected target unavailable')
      const handle=beginColdSelectedFinalization(coordinator,inspected.target)
      try{await handle.use();await handle.settle();return handle.commitReady()}
      finally{await handle.close()}
    },
    async fork(sourceSessionId: string) {
      const prepared = await controller.prepare({ version: 1, sourceSessionId })
      if (prepared.kind !== 'prepared') throw new Error('Shipping fork preparation refused: ' + JSON.stringify(prepared))
      const targetSessionId = randomUUID(), operation = createForkOperation(prepared.prepared, { operationId: randomUUID(), targetSessionId, createdAt: new Date().toISOString() })
      const outcome = await controller.execute({ operation, mode: 'begin' })
      console.info(JSON.stringify({ fixture: 'c67-shipping-fork', operation, outcome }))
      if (outcome.kind !== 'ready') throw new Error('Shipping fork did not reach READY: ' + JSON.stringify(outcome))
      return { sessionId: targetSessionId }
    },
    async close() { await controller.close(); await runtime.close(); await projects.close() },
  }
}
