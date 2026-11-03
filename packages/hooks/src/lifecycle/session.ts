import type { ClaudeSessionSource } from "../types.ts"
import { HookConfigError, HookTrustError, HOOK_OUTPUT_CAP_BYTES } from "../types.ts"
import type { InternalRegistry, HookRegistry, LoadedHandler } from "../registry-types.ts"
import { verifyHandlerTrust } from "../trust.ts"
import { assertAllowed } from "../runner.ts"
import { runHandlers } from "../execution/handlers.ts"

/** Startup cache and pending work have one owner, with live registry authority reads. */
export function createSessionLifecycle(
  registry: InternalRegistry,
  isDisposed: () => boolean,
  getTrustRevision: () => number,
  isApproved: (sha256: string) => boolean,
) {
  const configDir = registry.opts.configDir
  let startupRevision = 0
  let activeSession: { sessionId: string; source: ClaudeSessionSource } | undefined
  type StartupResult = { handlerId: string; sha256: string; sessionId: string; source: ClaudeSessionSource; text: string }
  const startupResults = new Map<string, StartupResult>()
  const startupPending = new Map<string, { revision: number; promise: Promise<void> }>()
  const startupKey = (handler: LoadedHandler, sessionId: string, source: ClaudeSessionSource): string => JSON.stringify([handler.spec.id, handler.spec.trust.sha256, sessionId, source])
  const removeBundleContext = (handler: LoadedHandler): void => {
    for (const [key, row] of startupResults) if (row.sha256 === handler.spec.trust.sha256) startupResults.delete(key)
  }
  const removeHandlerContext = (handler: LoadedHandler): void => {
    for (const [key, row] of startupResults) if (row.handlerId === handler.spec.id && row.sha256 === handler.spec.trust.sha256) startupResults.delete(key)
  }

  async function beginSession(sessionId: string, source: ClaudeSessionSource = "startup"): Promise<void> {
    if (isDisposed()) return
    if (activeSession?.sessionId !== sessionId || activeSession.source !== source) {
      if (activeSession?.sessionId !== sessionId) startupResults.clear()
      activeSession = { sessionId, source }; ++startupRevision
    }
    // Preserve native lifecycle observers, including their existing replay semantics.
    await runHandlers(registry, "session/start", { event: "session/start", sessionId })
    const revision = startupRevision, trust = getTrustRevision()
    for (const handler of registry.loaded) {
      const claude = handler.spec.claude
      if (claude?.event !== "SessionStart" || claude.matcher !== undefined && claude.matcher !== "*" && claude.matcher !== "" && !new RegExp(claude.matcher).test(source)) continue
      if (!handler.valid || !isApproved(handler.spec.trust.sha256)) {
        removeBundleContext(handler)
        if (!registry.reportedUnapproved.has(handler.spec.id)) {
          registry.reportedUnapproved.add(handler.spec.id)
          registry.opts.report(new HookTrustError(handler.spec.id, handler.spec.trust.sha256, handler.trustError ?? "handler is not approved"))
        }
        continue
      }
      // A cached result is reusable only after checking the bundle again.
      try { await verifyHandlerTrust(handler.spec, configDir) } catch (error) {
        if (isDisposed() || revision !== startupRevision || trust !== getTrustRevision() || !registry.loaded.includes(handler)) return
        removeBundleContext(handler); handler.valid = false; handler.unapproved = false
        handler.trustError = error instanceof Error ? error.message : String(error)
        registry.opts.report(error); continue
      }
      if (isDisposed() || revision !== startupRevision || trust !== getTrustRevision() || activeSession?.sessionId !== sessionId || activeSession.source !== source) return
      const key = startupKey(handler, sessionId, source)
      if (startupResults.has(key)) continue
      const pending = startupPending.get(key)
      if (pending?.revision === revision) { await pending.promise; continue }
      const promise = (async () => {
        try {
          const output = await registry.run(handler, { event: "session/start", sessionId }, { source })
          assertAllowed(output, handler.spec.id)
          // Execution can overlap revoke, refresh, remount, or another session.
          if (isDisposed() || revision !== startupRevision || trust !== getTrustRevision() || !registry.loaded.includes(handler) || !handler.valid || !isApproved(handler.spec.trust.sha256)) return
          await verifyHandlerTrust(handler.spec, configDir)
          if (isDisposed() || revision !== startupRevision || trust !== getTrustRevision() || !handler.valid || !isApproved(handler.spec.trust.sha256)) return
          startupResults.set(key, { handlerId: handler.spec.id, sha256: handler.spec.trust.sha256, sessionId, source, text: output.additionalContext ?? "" })
        } catch (error) {
          if (isDisposed() || revision !== startupRevision || trust !== getTrustRevision() || !registry.loaded.includes(handler)) return
          // Exit/output failures belong to one handler. A changed or unreadable
          // bundle withdraws every sibling result sharing that content grant.
          let trustError: unknown = error instanceof HookTrustError ? error : undefined
          if (trustError === undefined) {
            try { await verifyHandlerTrust(handler.spec, configDir) } catch (failure) { trustError = failure }
          }
          if (isDisposed() || revision !== startupRevision || trust !== getTrustRevision() || !registry.loaded.includes(handler)) return
          if (trustError !== undefined || !isApproved(handler.spec.trust.sha256)) removeBundleContext(handler)
          else removeHandlerContext(handler)
          if (trustError !== undefined) {
            handler.valid = false; handler.unapproved = false
            handler.trustError = trustError instanceof Error ? trustError.message : String(trustError)
          }
          registry.opts.report(trustError ?? error)
        }
      })()
      startupPending.set(key, { revision, promise })
      try { await promise } finally { if (startupPending.get(key)?.promise === promise) startupPending.delete(key) }
    }
  }

  return {
    advanceStartupRevision() { ++startupRevision },
    takeStartupResults() {
      const previous = [...startupResults.entries()]
      startupResults.clear()
      return previous
    },
    restoreStartup(previous: [string, StartupResult][], loaded: LoadedHandler[]) {
      for (const [key, result] of previous) {
        if (result.sessionId === activeSession?.sessionId && loaded.some(handler => handler.valid && handler.spec.claude !== undefined && handler.spec.id === result.handlerId && handler.spec.trust.sha256 === result.sha256)) startupResults.set(key, result)
      }
    },
    clearStartup() { ++startupRevision; startupResults.clear() },
    async fire(event: Parameters<HookRegistry["fire"]>[0], input: Parameters<HookRegistry["fire"]>[1]) {
      if (event === "session/start" || event === "session/end" || event === "subagent/stop") {
        if (typeof input.sessionId !== "string") {
          throw new HookConfigError(`hooks fire(${event}) requires sessionId`)
        }
        if (event === "session/start") await beginSession(input.sessionId)
        else await runHandlers(registry, event, { event, sessionId: input.sessionId }, undefined, false, {
          ...input, matchValue: event === "session/end" ? input.reason ?? "other" : input.agentType === "explore" ? "Explore" : input.agentType,
        })
      } else if (event === "notification") {
        await runHandlers(registry, "notification", { event: "notification", message: input.message ?? "" }, undefined, false, {
          ...input, matchValue: input.notificationType ?? "ih_notification",
        })
      } else {
        throw new HookConfigError(`hooks fire(${event}) is not a programmatic event`)
      }
    },
    beginSession,
    async endSession(sessionId: string) {
      await runHandlers(registry, "session/end", { event: "session/end", sessionId }, undefined, false, { matchValue: "other" })
    },

    context() {
      if (isDisposed() || activeSession === undefined) return ""
      const parts: string[] = []
      for (const handler of registry.loaded) {
        if (handler.spec.claude === undefined) continue
        if (!handler.valid || !isApproved(handler.spec.trust.sha256)) { removeBundleContext(handler); continue }
        const output = startupResults.get(startupKey(handler, activeSession.sessionId, activeSession.source))
        if (output?.text) parts.push(output.text)
      }
      return Buffer.from(parts.join("\n\n")).subarray(0, HOOK_OUTPUT_CAP_BYTES).toString("utf8")
    },
  }
}
