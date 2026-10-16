import type { ClaudeHookSession } from "../types.ts"
import { HookTrustError } from "../types.ts"
import type { HookRegistryOptions, InternalRegistry } from "../registry-types.ts"
import { runHookHandler } from "../runner.ts"
import { verifyHandlerTrust } from "../trust.ts"
import type { createClaudeTranscriptProjection } from "../claude-transcript.ts"
import type { claudeRuntimeService } from "../claude-runtime.ts"

/** Per-registry command invocation capability; owns only ephemeral child identities. */
export function createHandlerRuntime(
  registry: Pick<InternalRegistry, "current" | "opts">,
  opts: HookRegistryOptions,
  projection: ReturnType<typeof createClaudeTranscriptProjection>,
  runtimeService: ReturnType<typeof claudeRuntimeService>,
): InternalRegistry["run"] {
  const configDir = registry.opts.configDir
  const sessionIds = new WeakMap<ClaudeHookSession, string>()
  let ephemeralIds = 0
  const fallbackSession = (): ClaudeHookSession | undefined => typeof opts.session === "function" ? opts.session() : opts.session

  return async function run(handler, context, input = {}) {
    if (handler.spec.claude === undefined) return runHookHandler(handler.spec, context, configDir, { env: registry.opts.env, signal: input.signal, validateCurrent: () => registry.current(handler) })
    if (!registry.current(handler)) throw new HookTrustError(handler.spec.id, handler.spec.trust.sha256, "handler grant is not current")
    const fallback = fallbackSession(), session = input.session ?? fallback
    let sessionId = "sessionId" in context && context.sessionId ? context.sessionId : input.sessionId
    if (sessionId === undefined && session && session !== fallback) {
      sessionId = sessionIds.get(session)
      if (sessionId === undefined) { sessionId = `ih-ephemeral-${++ephemeralIds}`; sessionIds.set(session, sessionId) }
    }
    sessionId ??= opts.sessionId ?? ""
    const cwd = input.cwd ?? opts.cwd ?? process.cwd()
    const capture = session ? await projection.capture(session, sessionId, cwd) : undefined
    try {
      const output = await runHookHandler(handler.spec, context, configDir, {
        ...input, sessionId, cwd, env: registry.opts.env,
        validateCurrent: () => registry.current(handler),
        ...(capture ? { transcriptPath: capture.path } : {}),
        permissionMode: typeof opts.permissionMode === "function" ? opts.permissionMode({ session, sessionId }) : opts.permissionMode ?? "default",
      })
      if (!registry.current(handler)) throw new HookTrustError(handler.spec.id, handler.spec.trust.sha256, "handler grant changed during execution")
      await verifyHandlerTrust(handler.spec, configDir)
      if (session && output.additionalContext && context.event !== "session/start" && context.event !== "stop" && context.event !== "subagent/stop") {
        runtimeService.queueContext(session, output.additionalContext, () => registry.current(handler))
      }
      return output
    } finally { await capture?.release() }
  }
}
