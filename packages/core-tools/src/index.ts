import type { PluginContext } from "@i-harness/core-plugin"
import type { ToolRegistry, ToolCall, ToolResult } from "./types.ts"
import { createCatalog } from "./registry/catalog.ts"
import { createPreparer } from "./registry/prepare.ts"
import { createDispatcher } from "./registry/dispatch.ts"
import { createFinalizer } from "./registry/finalize.ts"
import { installPreExecuteDecision } from "./approval/decision.ts"

export { isPolicyRefusal, INVALID_ARGS, ToolArgsError, ToolNotFoundError, TOOL_FAILED, TOOL_ABORTED_BEFORE_DISPATCH, TOOL_CANCELLED_BY_SIBLING, TOOL_ABORTED_MID_FLIGHT, TOOL_TIMEOUT } from "./types.ts"
export type { MediaGenerationAction, ToolModelGeneration, CodeGenerationLineage, CodeGenerationScope } from './types.ts'
export type { ToolExposure, Tool, PreparedToolIdentity, PreparedApprovalInput, ApprovalRememberView, PreparedApprovalProvider, ApprovalAuthorityProvider, ToolExec, ToolDecision, PolicyRefusal, ToolCall, ToolResult, PreparedCall, ToolDispatchMetadata, ToolSchema, SearchableTool, GuardianRequest, GuardianVerdict, ApprovalGuardian, ToolRegistry } from "./types.ts"
export { validateJsonSchemaValue, type JsonSchemaNode } from "./json-schema.ts"
export { waitForObservation, userSteerForTool, type UserSteerSource } from "./observation.ts"
export { retainedToolOutcome, hasRetainedToolBody, type RetainedToolOutcome, type RetainedOutcomeSink } from './registry/retained-outcome.ts'

// M27-R-A8: get_context_remaining — registered only when a contextWindow is
// known (fail-closed); see context-remaining.ts.
export { registerContextRemaining } from "./context-remaining.ts"
export type { ContextRemainingOptions } from "./context-remaining.ts"

export function createToolRegistry(ctx: PluginContext): ToolRegistry {
  const catalog = createCatalog()
  installPreExecuteDecision(ctx)
  const prepare = createPreparer(ctx, catalog, () => registry)
  const dispatch = createDispatcher(ctx, catalog.get, () => registry)
  const finalize = createFinalizer(ctx)

  // M13: thin sequential wrapper — behavior byte-identical to the pre-M13
  // `execute` for every existing caller (tests, CLI paths, subagent drivers).
  async function execute(call: ToolCall, opts?: { signal?: AbortSignal }): Promise<ToolResult> {
    const prepared = await prepare(call, opts?.signal)
    const output = await dispatch(prepared)
    return finalize(prepared, output)
  }

  const registry: ToolRegistry = {
    register: catalog.register,
    get: catalog.get,
    unregister: catalog.unregister,
    schemas: catalog.schemas,
    prepare,
    dispatch,
    finalize,
    execute,
    genToolCatalog: catalog.genToolCatalog,
    verifyToolCatalog: catalog.verifyToolCatalog,
    installSearch: catalog.installSearch,
    search: catalog.search,
    promote: catalog.promote,
    deferredSearchIndex: catalog.deferredSearchIndex,
    deferredToolCount: catalog.deferredToolCount,
  }
  return registry
}
