import type { AgentConfig, AgentDeps } from './types.ts'
import type { LiveInvocation } from '../tool-batch/live-continuation.ts'

export type ExecutionDependencies = AgentDeps & AgentConfig & { liveInvocation?: LiveInvocation; assertBorrowedGeneration?: () => void; assertLiveOwnerReady?: () => void }
type Dependencies = ExecutionDependencies

/** Host preferences stay live on their original receiver. Only execution ports
 * and fixed construction identities belong to this private Agent facade. */
export function createExecutionDependencies(host: Dependencies): Dependencies {
  const deps = {} as Dependencies
  const live = [
    'model', 'tools', 'systemPrompt', 'signal', 'budget', 'compact',
    'reasoningEffort', 'maxOutputTokens', 'modelActionTimeoutMs', 'modelActionMaxAttempts',
    'autoCompactionEnabled', 'generationFactory', 'inputPreparationFactory', 'summaryFactory',
    'sharedGeneration', 'ensureWritableContext', 'executionIdentity', 'bindingForStep',
    'modelBindingIdentity', 'budgetBinding', 'contextMetadata', 'modelToolSchemas',
    'modelOverheadTokens', 'isSubagent', 'telemetry', 'flush', 'stepInputs', 'requestContext',
  ] as const satisfies readonly (keyof Dependencies)[]
  for (const key of live) Object.defineProperty(deps, key, {
    enumerable: true,
    get() {
      const value = host[key]
      // Bind only the host's top-level callbacks. Nested clients and step-input
      // objects are forwarded intact so their methods retain their own receiver.
      return typeof value === 'function' ? value.bind(host) : value
    },
  })
  for (const key of ['session', 'factOwner', 'sessionId', 'maxTurns', 'maxParallelToolCalls'] as const) {
    Object.defineProperty(deps, key, { value: host[key], enumerable: true })
  }
  // These names intentionally never read or write the caller's object.
  for (const key of [
    'sharedBudget', 'generationAction', 'generationLifecycle', 'inputPreparation',
    'facts', 'sourceFacts', 'assertFactOpen', 'captureContextReduction',
    'captureSoftReduction', 'captureInputPromotion', 'captureModelExchange', 'registerFactSource',
  ] as const satisfies readonly (keyof Dependencies)[]) {
    Object.defineProperty(deps, key, { value: undefined, writable: true, enumerable: true })
  }
  for (const key of ['liveInvocation', 'assertBorrowedGeneration', 'assertLiveOwnerReady'] as const) Object.defineProperty(deps, key, { value: undefined, writable: true })
  return deps
}
