import type { ToolCall, ToolDecision } from "@i-harness/core-tools"
import type { HookOutput } from "../types.ts"
import { HookTrustError } from "../types.ts"
import type { InternalRegistry, HookRuntimeInput } from "../registry-types.ts"
import { matches } from "../configuration/matchers.ts"

/** Permission handlers → ToolDecision | undefined (undefined = no decision). */
export async function permissionDecision(
  registry: InternalRegistry,
  call: ToolCall & HookRuntimeInput,
): Promise<ToolDecision | undefined> {
  for (const handler of registry.loaded) {
    if (!matches(handler, "permission", call.name, call)) continue
    if (!handler.valid) {
      if (handler.spec.claude !== undefined && handler.unapproved === true) {
        if (!registry.reportedUnapproved.has(handler.spec.id)) {
          registry.reportedUnapproved.add(handler.spec.id)
          registry.opts.report(new HookTrustError(handler.spec.id, handler.spec.trust.sha256, handler.trustError ?? "handler is not approved"))
        }
        continue
      }
      return { kind: "deny", reason: `hook handler ${handler.spec.id} failed trust verification` }
    }
    let output: HookOutput
    try {
      output = await registry.run(
        handler,
        { event: "permission", tool: { name: call.name, args: call.args } },
        call,
      )
    } catch (err) {
      return { kind: "deny", reason: `hook handler ${handler.spec.id} failed closed: ${err instanceof Error ? err.message : String(err)}` }
    }
    if (handler.spec.claude !== undefined && (output.continue === false || output.block === true)) return { kind: "deny", reason: output.reason ?? output.stopReason ?? "Claude permission hook stopped the action" }
    if (output.decision === undefined) continue
    // A plugin's allow can never grant more than IH's host permission policy.
    if (output.decision === "allow") { if (handler.spec.claude !== undefined) continue; return { kind: "allow" } }
    // ask is not wired to a question seam on main yet — fail closed as deny.
    return { kind: "deny", reason: output.reason ?? output.stopReason ?? `hook handler ${handler.spec.id} requires approval` }
  }
  return undefined
}
