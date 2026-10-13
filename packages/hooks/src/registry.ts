import { existsSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { dirname } from "node:path"
import type { PluginContext } from "@i-harness/core-plugin"
import { currentDiagnostics } from "@i-harness/diagnostics"
import { HookConfigError } from "./types.ts"
import type { HookRegistryOptions, HookRegistry, InternalRegistry } from "./registry-types.ts"
import type { HookTrustStore } from "./trust.ts"
import { createClaudeTranscriptProjection } from "./claude-transcript.ts"
import { claudeRuntimeService } from "./claude-runtime.ts"
import { loadHooksConfig, resolveHooksConfigPath } from "./configuration/load.ts"
import { createHandlerRuntime } from "./execution/runtime.ts"
import { createSessionLifecycle } from "./lifecycle/session.ts"
import { mountHookListeners, registerRuntimeStop } from "./lifecycle/mount.ts"

/**
 * Create + mount the hooks registry on the running PluginContext:
 *   - pre-tool/post-tool → `tools/execute` cascade wrap (gate);
 *   - permission         → `tools/pre-execute` plain listener producing a
 *     ToolDecision (merged by core-tools' own closed-vocabulary waterfall);
 *   - prompt/submit      → `agent/pre-step` waterfall (block ⇔ throw);
 *   - stop               → `agent/stop` listener (block ⇔ throw).
 * The config is loaded up front: an EXPLICIT configPath that is unreadable
 * throws (fail-closed); a missing DEFAULT config simply yields zero handlers
 * (the host may not use hooks at all).
 */
// W6 T6: the observer-side failure reporter's default. The registry is created
// as a host MOUNTS hooks, so its reports are phase `mount`. The body reaches the
// ambient diagnostics instance when a host installed one and is the console call
// it always was when none is: same function, same single verbatim argument. The
// `report` option's signature is untouched.
function defaultReport(err: unknown): void {
  const message = `[hooks] ${err instanceof Error ? err.message : String(err)}`
  const d = currentDiagnostics()
  if (d === undefined) console.warn(message)
  else d.child("mount").warn(message)
}

export async function createHookRegistry(ctx: PluginContext, opts: HookRegistryOptions = {}): Promise<HookRegistry> {
  const explicitConfigPath = opts.configPath !== undefined
  const configPath = opts.configPath ?? resolveHooksConfigPath(opts.configDir)
  const configDir = opts.configDir ?? dirname(configPath)
  const projection = createClaudeTranscriptProjection()
  const runtimeService = claudeRuntimeService(ctx)
  let disposed = false
  let trustRevision = 0
  let activeApprovals: Pick<HookTrustStore, "isApproved"> | undefined = opts.approvals
  const registry: InternalRegistry = {
    loaded: [],
    reportedUnapproved: new Set<string>(),
    opts: { report: opts.report ?? defaultReport, env: opts.env ?? {}, configDir },
    current: (handler) => !disposed && registry.loaded.includes(handler) && handler.valid
      && (handler.spec.claude === undefined || activeApprovals?.isApproved(handler.spec.trust.sha256) === true),
    run(handler, context, input) { return run(handler, context, input) },
  }
  const run = createHandlerRuntime(registry, opts, projection, runtimeService)
  // Missing file: an EXPLICIT configPath fails closed (the caller named a
  // config — its absence is a hard error); a DEFAULT-derived path simply
  // yields zero handlers (a host that never configured hooks).
  if (existsSync(configPath)) {
    registry.loaded = await loadHooksConfig(configPath, configDir, opts.approvals, opts)
  } else if (explicitConfigPath) {
    throw new HookConfigError(`hooks config ${configPath} does not exist (explicit configPath)`)
  }

  const mountName = `hooks:${randomUUID()}`
  const lifecycle = createSessionLifecycle(registry, () => disposed, () => trustRevision,
    sha256 => activeApprovals?.isApproved(sha256) === true)
  const removeStop = registerRuntimeStop(registry, runtimeService, () => disposed)
  mountHookListeners(ctx, registry, mountName)
  return {
    async refreshTrust(approvals) {
      if (disposed) throw new HookConfigError("hooks registry is disposed")
      const revision = ++trustRevision
      lifecycle.advanceStartupRevision()
      activeApprovals = approvals
      const previous = lifecycle.takeStartupResults()
      registry.loaded = registry.loaded.map((row) => ({ ...row, valid: false, unapproved: false, trustError: "Hook trust refresh is in progress" }))
      const loaded = await loadHooksConfig(configPath, configDir, approvals, opts)
      if (disposed || revision !== trustRevision) return
      registry.loaded = loaded
      registry.reportedUnapproved.clear()
      lifecycle.restoreStartup(previous, loaded)
    },

    async dispose() { if (disposed) return; disposed = true; removeStop(); lifecycle.clearStartup(); await ctx.unmount(mountName); registry.loaded = []; await projection.dispose() },
    fire: lifecycle.fire,
    beginSession: lifecycle.beginSession,
    endSession: lifecycle.endSession,
    handlers: () => registry.loaded.map((h) => ({ ...h, spec: structuredClone(h.spec) })),
    context: lifecycle.context,
  }
}
