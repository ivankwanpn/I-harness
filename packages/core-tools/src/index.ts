import type { PluginContext } from "@i-harness/core-plugin"
import type { ToolRegistry, ToolCall, ToolResult } from "./types.ts"
import { createCatalog } from "./registry/catalog.ts"
import { createPreparer } from "./registry/prepare.ts"
import { createDispatcher } from "./registry/dispatch.ts"
import { createFinalizer } from "./registry/finalize.ts"
import { installPreExecuteDecision } from "./approval/decision.ts"
import { assertSyntheticResult, bindSyntheticFinalization, type ToolResultRetention } from './registry/result-finalization.ts'
import { isNativePlanValidationError } from './instructions.ts'
import { isPolicyRefusal } from './types.ts'
export { assertResultPrepared, assertSyntheticResult, declareToolResultOutcome, declareToolResultPresentation, resultExecution, resultPresentation, isOriginalResultFinalization, isOriginalSyntheticResultFinalization } from './registry/result-finalization.ts'
export type { ResultFinalization, ResultProgram, ToolResultRetention, SyntheticResultContext } from './registry/result-finalization.ts'
export { currentToolResultProducer, registerToolResultDependency, toolResultDependencies } from './registry/result-dependencies.ts'
export type { ToolResultDependency } from './registry/result-dependencies.ts'

export { isPolicyRefusal, INVALID_ARGS, ToolArgsError, ToolNotFoundError, TOOL_FAILED, TOOL_ABORTED_BEFORE_DISPATCH, TOOL_CANCELLED_BY_SIBLING, TOOL_ABORTED_MID_FLIGHT, TOOL_TIMEOUT } from "./types.ts"
export type { MediaGenerationAction, ToolModelGeneration, CodeGenerationLineage, CodeGenerationScope } from './types.ts'
export type { NativeTarget, NativePlan, NativeMutation, NativeBoundary, CapturedToolCall, AcceptedInstructionCall, AcceptedCallDescriptor, AcceptedInstructionBatch, InstructionBatchEntry, ToolPrepareIdentity } from './types.ts'
export { NativePlanValidationError, nativePlanValidationFailure, isNativePlanValidationError, nativeOperation, nativeMutation, capturedToolRegistry, instructionReplan, isInstructionReplan, InstructionReplanError, declareInstructionReplan, instructionReplanDisposition } from './instructions.ts'
export type { InstructionReplanData } from './instructions.ts'
export type { ToolExposure, Tool, PreparedToolIdentity, PreparedApprovalInput, ApprovalRememberView, PreparedApprovalProvider, ApprovalAuthorityProvider, ToolExec, ToolDecision, PolicyRefusal, ToolCall, ToolResult, PreparedCall, ToolDispatchMetadata, ToolSchema, SearchableTool, GuardianRequest, GuardianVerdict, ApprovalGuardian, ToolRegistry } from "./types.ts"
export { validateJsonSchemaValue, type JsonSchemaNode } from "./json-schema.ts"
export { waitForObservation, userSteerForTool, type UserSteerSource } from "./observation.ts"
export { retainedToolOutcome, hasRetainedToolBody, type RetainedToolOutcome, type RetainedOutcomeSink } from './registry/retained-outcome.ts'

// M27-R-A8: get_context_remaining — registered only when a contextWindow is
// known (fail-closed); see context-remaining.ts.
export { registerContextRemaining } from "./context-remaining.ts"
export type { ContextRemainingOptions } from "./context-remaining.ts"

const registryRetention = new WeakMap<ToolRegistry, ToolResultRetention | undefined>()
const registryInstructions = new WeakMap<ToolRegistry, { required: boolean; verify?: (origin: import('./types.ts').AcceptedInstructionCall, capture: import('./types.ts').CapturedToolCall) => boolean }>()
export function registryRequiresInstructionOrigin(registry: ToolRegistry): boolean { return registryInstructions.get(registry)?.required === true }
export function createToolRegistry(ctx: PluginContext, options: { resultRetention?: ToolResultRetention; inheritResultRetention?: ToolRegistry; instructionsRequired?: boolean; instructionOriginVerifier?: (origin: import('./types.ts').AcceptedInstructionCall, capture: import('./types.ts').CapturedToolCall) => boolean } = {}): ToolRegistry {
  if (options.inheritResultRetention && !registryRetention.has(options.inheritResultRetention)) throw new Error('Original tool registry unavailable')
  const retention = options.resultRetention ?? (options.inheritResultRetention ? registryRetention.get(options.inheritResultRetention) : undefined)
  const catalog = createCatalog()
  installPreExecuteDecision(ctx)
  const inherited = options.inheritResultRetention ? registryInstructions.get(options.inheritResultRetention) : undefined
  const verifierDescriptor = Object.getOwnPropertyDescriptor(options, 'instructionOriginVerifier')
  if (verifierDescriptor && (!('value' in verifierDescriptor) || typeof verifierDescriptor.value !== 'function')) throw new TypeError('Invalid instruction origin verifier')
  const verify = inherited?.verify ?? (verifierDescriptor && 'value' in verifierDescriptor ? verifierDescriptor.value.bind(options) : undefined)
  const required = inherited?.required === true || options.instructionsRequired === true
  const preparer = createPreparer(ctx, catalog, () => registry, required, verify)
  const prepareCaptured: ToolRegistry['prepareCaptured'] = async (...args) => {
    const prepared = await preparer.prepareCaptured(...args)
    await retention?.prepare?.(prepared)
    return prepared
  }
  const prepare: ToolRegistry['prepare'] = async (...args) => {
    return prepareCaptured(preparer.capture(args[0], args[2]), args[1])
  }
  const dispatch = createDispatcher(ctx, catalog.get, () => registry, preparer.invokePrepared)
  const { finalize, resultFinalization } = createFinalizer(ctx, retention)

  // M13: thin sequential wrapper — behavior byte-identical to the pre-M13
  // `execute` for every existing caller (tests, CLI paths, subagent drivers).
  async function execute(call: ToolCall, opts?: { signal?: AbortSignal }): Promise<ToolResult> {
    let prepared
    try { prepared = await prepare(call, opts?.signal) }
    catch (error) {
      if (!isPolicyRefusal(error) && isNativePlanValidationError(error)) return { name: call.name, output: error.output }
      throw error
    }
    const output = await dispatch(prepared)
    return finalize(prepared, output)
  }

  const registry: ToolRegistry = {
    register: catalog.register,
    get: catalog.get,
    unregister: catalog.unregister,
    schemas: catalog.schemas,
    capture: preparer.capture,
    inspectCapture: preparer.inspectCapture,
    bindNativeInstructions: preparer.bindNativeInstructions,
    prepareCaptured,
    prepare,
    dispatch,
    finalize,
    resultFinalization,
    captureSyntheticResult(context, output, execution) {
      if (!retention) return undefined
      assertSyntheticResult(context)
      return bindSyntheticFinalization(context, retention.captureSynthetic(context, output, execution))
    },
    execute,
    genToolCatalog: catalog.genToolCatalog,
    verifyToolCatalog: catalog.verifyToolCatalog,
    installSearch: catalog.installSearch,
    search: catalog.search,
    promote: catalog.promote,
    deferredSearchIndex: catalog.deferredSearchIndex,
    deferredToolCount: catalog.deferredToolCount,
  }
  registryRetention.set(registry, retention)
  registryInstructions.set(registry, { required, verify })
  return registry
}
