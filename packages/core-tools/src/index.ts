import type { PluginContext } from "@i-harness/core-plugin"
import { associateOriginalCodeCatalog, captureExecutionOwnerContext, preparedExecutionOwnerContext,preparedManagedExecutionDomain, type ToolExecutionOwnerContext,type ManagedToolExecutionOwnerContext } from './registry/prepared-body.ts'
export { bindPreparedShellLeaf, assertPreparedExecutionOwnerContext } from './registry/prepared-body.ts'
export {readToolInvocationDomain} from './registry/invocation-domain.ts'
export type { PreparedShellBodyClaim, ToolExecutionOwnerContext,ManagedToolExecutionOwnerContext } from './registry/prepared-body.ts'
import type { ToolRegistry, ToolCall, ToolResult } from "./types.ts"
import { createCatalog } from "./registry/catalog.ts"
import { createPreparer } from "./registry/prepare.ts"
import { createDispatcher } from "./registry/dispatch.ts"
import { createFinalizer } from "./registry/finalize.ts"
import { installPreExecuteDecision } from "./approval/decision.ts"
import { assertSyntheticResult,assertManagedSyntheticResult, bindSyntheticFinalization, type ToolResultRetention } from './registry/result-finalization.ts'
import { isNativePlanValidationError } from './instructions.ts'
import { isPolicyRefusal } from './types.ts'
export { assertResultPrepared, assertSyntheticResult, declareToolResultOutcome, declareToolResultPresentation, resultExecution, resultPresentation, isOriginalResultFinalization, isOriginalSyntheticResultFinalization,retainedFinalizedToolResult,releaseFinalizedToolResult } from './registry/result-finalization.ts'
export type { ResultFinalization, ResultProgram, ToolResultRetention, SyntheticResultContext,ManagedSyntheticResultContext } from './registry/result-finalization.ts'
export { currentToolResultProducer, registerToolResultDependency, toolResultDependencies } from './registry/result-dependencies.ts'
export type { ToolResultDependency } from './registry/result-dependencies.ts'

export { APPROVAL_POLICY_SERVICE } from "./types.ts"
export { isPolicyRefusal, INVALID_ARGS, ToolArgsError, ToolNotFoundError, TOOL_FAILED, TOOL_ABORTED_BEFORE_DISPATCH, TOOL_CANCELLED_BY_SIBLING, TOOL_ABORTED_MID_FLIGHT, TOOL_TIMEOUT } from "./types.ts"
export type { MediaGenerationAction, ToolModelGeneration, CodeGenerationLineage, CodeGenerationScope } from './types.ts'
export type { NativePlan, NativeMutation, NativeBoundary, CapturedToolCall, AcceptedInstructionCall, AcceptedCallDescriptor, AcceptedInstructionBatch, InstructionBatchEntry, InstructionCellOrigin, InstructionCellLease, ToolPrepareIdentity } from './types.ts'
export { nativePlanValidationFailure, isNativePlanValidationError, nativeOperation, nativeMutation, capturedToolRegistry,capturedManagedExecutionDomain, instructionReplan, isInstructionReplan, InstructionReplanError, declareInstructionReplan, instructionReplanDisposition, retainInstructionCell, bindInstructionInvocation, preflightInstructionInvocations, releaseInstructionCell, isOriginalInstructionCellRequest } from './instructions.ts'
export type { InstructionReplanData } from './instructions.ts'
export type { ToolExposure, Tool, PreparedToolIdentity, PreparedApprovalInput, ApprovalRememberView, PreparedApprovalProvider, ApprovalAuthorityProvider, ToolExec, ToolDecision, PolicyRefusal, ToolCall, ToolResult, PreparedCall, ToolDispatchMetadata, ToolSchema, SearchableTool, GuardianRequest, GuardianVerdict, ApprovalGuardian, ToolRegistry } from "./types.ts"
export { validateJsonSchemaValue, type JsonSchemaNode } from "./json-schema.ts"
export { waitForObservation, userSteerForTool, backgroundEventForTool, type UserSteerSource } from "./observation.ts"
export { retainedToolOutcome, hasRetainedToolBody, type RetainedToolOutcome, type RetainedOutcomeSink } from './registry/retained-outcome.ts'

// M27-R-A8: get_context_remaining — registered only when a contextWindow is
// known (fail-closed); see context-remaining.ts.
export { registerContextRemaining } from "./context-remaining.ts"
export type { ContextRemainingOptions } from "./context-remaining.ts"

const registryRetention = new WeakMap<ToolRegistry, ToolResultRetention | undefined>()
const registryInstructions = new WeakMap<ToolRegistry, { required: boolean; verify?: (origin: import('./types.ts').AcceptedInstructionCall, capture: import('./types.ts').CapturedToolCall) => boolean; retainCell?: (origin: import('./types.ts').AcceptedInstructionCall, capture: import('./types.ts').CapturedToolCall, cellId: string, request: object) => import('./types.ts').InstructionCellLease | undefined }>()
export function registryRequiresInstructionOrigin(registry: ToolRegistry): boolean { return registryInstructions.get(registry)?.required === true }
const originPairs=new WeakMap<object,{registry:ToolRegistry;verifier:object}>()
export function assertModelOriginPair(registry:ToolRegistry,driver:object,verifier:object){const original=originPairs.get(driver);if(!original||original.registry!==registry||original.verifier!==verifier)throw Error('Original model registry/driver pair required')}
type RegistryOptions = { resultRetention?: ToolResultRetention; inheritResultRetention?: ToolRegistry; executionOwner?: ToolExecutionOwnerContext|ManagedToolExecutionOwnerContext; instructionsRequired?: boolean; instructionOriginVerifier?: (origin: import('./types.ts').AcceptedInstructionCall, capture: import('./types.ts').CapturedToolCall) => boolean; instructionCellRetainer?: (origin: import('./types.ts').AcceptedInstructionCall, capture: import('./types.ts').CapturedToolCall, cellId: string, request: object) => import('./types.ts').InstructionCellLease | undefined }
export function createToolRegistry(ctx: PluginContext, options: RegistryOptions = {}): ToolRegistry { return buildRegistry(ctx, options).registry }
export function createToolRegistryWithModelOrigin(ctx: PluginContext, options: RegistryOptions, verifier: import('./model-origin.ts').ConstructorModelOriginVerifier|import('./model-origin.ts').ConstructorManagedModelOriginVerifier) {
  const managed=Object.getOwnPropertyDescriptor(verifier,'kind')?.value==='managed-model-origin'
  const method = managed?Object.getOwnPropertyDescriptor(verifier,'take')?.value:verifier?.take
  if (typeof method !== 'function') throw new TypeError('Original verifier required')
  if(managed&&(!options.executionOwner||!('kind'in options.executionOwner)||options.executionOwner.domain!==Object.getOwnPropertyDescriptor(verifier,'domain')?.value))throw Error('Original managed verifier/domain required')
  const pair=buildRegistry(ctx, options, managed?{managed:method.bind(verifier)}:{public:method.bind(verifier)});originPairs.set(pair.driver,{registry:pair.registry,verifier});return pair
}
function buildRegistry(ctx: PluginContext, options: RegistryOptions, take?: import('./model-origin.ts').ModelOriginTake) {
  const ownerDescriptor = Object.getOwnPropertyDescriptor(options,'executionOwner')
  if (ownerDescriptor && !('value' in ownerDescriptor)) throw new TypeError('Execution owner must be own data')
  const executionOwner = captureExecutionOwnerContext(ctx, ownerDescriptor?.value)
  if (options.inheritResultRetention && !registryRetention.has(options.inheritResultRetention)) throw new Error('Original tool registry unavailable')
  const retention = options.resultRetention ?? (options.inheritResultRetention ? registryRetention.get(options.inheritResultRetention) : undefined)
  const catalog = createCatalog()
  installPreExecuteDecision(ctx)
  const inherited = options.inheritResultRetention ? registryInstructions.get(options.inheritResultRetention) : undefined
  const verifierDescriptor = Object.getOwnPropertyDescriptor(options, 'instructionOriginVerifier')
  if (verifierDescriptor && (!('value' in verifierDescriptor) || typeof verifierDescriptor.value !== 'function')) throw new TypeError('Invalid instruction origin verifier')
  const verify = inherited?.verify ?? (verifierDescriptor && 'value' in verifierDescriptor ? verifierDescriptor.value.bind(options) : undefined)
  const retainerDescriptor = Object.getOwnPropertyDescriptor(options, 'instructionCellRetainer')
  if (retainerDescriptor && (!('value' in retainerDescriptor) || typeof retainerDescriptor.value !== 'function')) throw new TypeError('Invalid instruction cell retainer')
  const retainCell = inherited?.retainCell ?? (retainerDescriptor && 'value' in retainerDescriptor ? retainerDescriptor.value.bind(options) : undefined)
  const required = inherited?.required === true || options.instructionsRequired === true
  const preparer = createPreparer(ctx, catalog, () => registry, required, verify, retainCell, executionOwner)
  const prepareCaptured: ToolRegistry['prepareCaptured'] = async (...args) => {
    const prepared = await preparer.prepareCaptured(...args)
    const domain=preparedManagedExecutionDomain(prepared)
    if(domain&&retention){if(!retention.prepareManaged)throw Error('Managed result retention requires its original private adapter');await retention.prepareManaged(prepared,domain)}else await retention?.prepare?.(prepared, preparedExecutionOwnerContext(prepared))
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
    captureManagedSyntheticResult(context,output,execution){assertManagedSyntheticResult(context);if(!retention)return undefined;if(!retention.captureManagedSynthetic)throw Error('Managed synthetic result retention requires original private adapter');return bindSyntheticFinalization(context,retention.captureManagedSynthetic(context,output,execution))},
    execute,
    genToolCatalog: catalog.genToolCatalog,
    verifyToolCatalog: catalog.verifyToolCatalog,
    installSearch: catalog.installSearch,
    search: catalog.search,
    promote: catalog.promote,
    deferredSearchIndex: catalog.deferredSearchIndex,
    deferredToolCount: catalog.deferredToolCount,
  }
  associateOriginalCodeCatalog(registry,tool=>catalog.captureBinding({name:tool.name,args:{}}))
  registryRetention.set(registry, retention)
  registryInstructions.set(registry, { required, verify, retainCell })
  const driver: import('./model-origin.ts').PreparedModelOriginDriver = Object.freeze({ attach(prepared: import('./types.ts').PreparedCall, proof: object) {
    if (this !== driver || !take) throw new Error('Original driver required')
    preparer.attachModelOrigin(prepared, proof, take)
  } })
  return { registry, driver }
}
