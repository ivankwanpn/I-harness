import type { HookContext, HookEventName, HookOutput } from "../types.ts"
import { HookBlockedError, HookTrustError, HookOwnerAbortError } from "../types.ts"
import type { InternalRegistry, HookRuntimeInput } from "../registry-types.ts"
import { assertAllowed } from "../runner.ts"
import { matches } from "../configuration/matchers.ts"

/**
 * Run the handlers for one event in config order. gate:true — every failure
 * becomes assertAllowed (deny/ask/block/continue:false → HookBlockedError)
 * and every handler error (trust/output/exit/timeout) also throws
 * fail-closed. gate:false — observer semantics: errors + broken-trust handlers
 * are reported, never fatal.
 */
export async function runHandlers(
  registry: InternalRegistry,
  event: HookEventName,
  context: HookContext,
  toolName?: string,
  gate = false,
  input?: HookRuntimeInput,
): Promise<HookOutput[]> {
  const outputs: HookOutput[] = []
  for (const handler of registry.loaded) {
    // Claude startup commands have a separate output/context session lifecycle.
    if (handler.spec.claude?.event === "SessionStart") continue
    if (!matches(handler, event, toolName, input)) continue
    if (!handler.valid) {
      const message = handler.trustError ?? "handler failed trust verification"
      if (handler.unapproved === true) {
        // Not the user's policy yet: acts in NEITHER direction, and is reported
        // ONCE (see InternalRegistry.reportedUnapproved).
        if (!registry.reportedUnapproved.has(handler.spec.id)) {
          registry.reportedUnapproved.add(handler.spec.id)
          registry.opts.report(new HookTrustError(handler.spec.id, handler.spec.trust.sha256, message))
        }
        continue
      }
      // A genuine mismatch: someone changed an approved artifact, so the gate
      // closes. See LoadedHandler.unapproved for why the two must differ.
      if (gate) throw new HookBlockedError(handler.spec.id, message)
      registry.opts.report(new HookTrustError(handler.spec.id, handler.spec.trust.sha256, message))
      continue
    }
    let output: HookOutput
    try {
      output = await registry.run(handler, context, input)
    } catch (err) {
      if (err instanceof HookOwnerAbortError) throw err
      if (!gate) {
        registry.opts.report(err)
        continue
      }
      throw new HookBlockedError(handler.spec.id, `handler failed closed: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (gate && !(handler.spec.claude !== undefined && event === "post-tool")) assertAllowed(output, handler.spec.id)
    outputs.push(output)
  }
  return outputs
}
