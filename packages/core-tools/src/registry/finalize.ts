import type { PluginContext } from "@i-harness/core-plugin"
import type { PreparedCall, ToolResult, ToolRegistry } from "../types.ts"

export function createFinalizer(ctx: PluginContext): ToolRegistry["finalize"] {
  async function finalize(prepared: PreparedCall, output: unknown): Promise<ToolResult> {
    // 5. post-execute waterfall.
    await ctx.emit("tools/post-execute", { name: prepared.call.name, output })
    return { name: prepared.call.name, output }
  }

  return finalize
}
