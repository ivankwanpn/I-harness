import type { AgentConfig, AgentDeps } from './types.ts'

type Dependencies = AgentDeps & AgentConfig

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
    'modelOverheadTokens', 'isSubagent', 'telemetry', 'flush', 'stepInputs',
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
    'captureSoftReduction', 'captureInputPromotion', 'registerFactSource',
  ] as const satisfies readonly (keyof Dependencies)[]) {
    Object.defineProperty(deps, key, { value: undefined, writable: true, enumerable: true })
  }
  return deps
}
