import type { PluginContext } from "@i-harness/core-plugin"
import type { PreparedCall, Tool, ToolDispatchMetadata, ToolRegistry } from "../types.ts"

export function createDispatcher(ctx: PluginContext, getTool: (name: string) => Tool | undefined, getRegistry: () => ToolRegistry): ToolRegistry["dispatch"] {
  // M13 dispatch stage — the ONLY overlapping stage: runs the around-seam
  // (`tools/execute` cascade handlers wrap the real tool body). `prepare` and
  // `finalize` run in the ordered lane so the policy layer stays model-ordered.
  function validatePrepared(prepared: PreparedCall): void {
    try {
      if (getTool(prepared.call.name) !== prepared.tool || !prepared.bindingValidation()) throw new Error("prepared tool binding changed: replaced or revoked before dispatch")
      if (prepared.authorityValidation?.() === false) throw new Error("prepared approval authority or policy changed before dispatch")
      if (prepared.approvalValidation?.() === false) throw new Error("prepared approval identity, rule or policy changed before dispatch")
      const guardReason = ctx.checkGuards("tools/execute", { name: prepared.call.name, args: prepared.call.args })
      if (guardReason !== undefined) throw new Error(`guard denied: ${guardReason}`)
    } catch (cause) {
      // These checks also run inside dispatch, after asynchronous hooks. Their
      // site is an authority gate, never a body failure the model can repair.
      throw Object.assign(new Error(cause instanceof Error ? cause.message : String(cause), { cause }), { policyRefusal: true as const })
    }
  }

  async function dispatch(prepared: PreparedCall): Promise<unknown> {
    validatePrepared(prepared)
    const output = await ctx.cascade(
      "tools/execute",
      { name: prepared.call.name, args: prepared.call.args, exec: prepared.exec, tool: prepared.tool,
        registry: getRegistry(), bindingGeneration: prepared.bindingGeneration, validateBinding: prepared.bindingValidation,
        ...(prepared.commandDialect !== undefined ? { commandDialect: prepared.commandDialect } : {}) } satisfies ToolDispatchMetadata,
      async () => {
        // Hooks may await before next(). No await is allowed between this final
        // authority check and invoking the body whose binding was validated.
        validatePrepared(prepared)
        return prepared.tool.execute(prepared.call.args as never, prepared.exec)
      },
    )
    return output
  }

  return dispatch
}
