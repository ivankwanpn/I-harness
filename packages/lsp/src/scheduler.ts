// Mount/unmount lifecycle for one LSP server (mirrors M17's mcp-client
// scheduler): validate config → reserve serverName → spawn + initialize
// handshake → register the lsp + lsp_diagnostics tools. A failed mount
// disposes the instance and releases the reservation (fail-closed hygiene);
// unmount is idempotent and the reservation dies even when dispose throws.
import type { PluginContext } from "@i-harness/core-plugin"
import type { ToolRegistry } from "@i-harness/core-tools"
import type { ConnectionSpec } from "./connection.ts"
import { LspInstance, type InstanceSpec } from "./instance.ts"
import { createLspTools } from "./tools.ts"
import { validateLspConfig, type LspServerConfig } from "./types.ts"

export interface LspMountHandle {
  serverName: string
  unmount(): Promise<void>
}

// Module-level reservation so a serverName can only ever be live once (a
// second mount with the same name is a hard error, not a silent shadow).
const liveServerNames = new Set<string>()

export async function mountLspClient(
  _ctx: PluginContext,
  tools: ToolRegistry,
  config: LspServerConfig,
  deps?: { spawner?: (spec: InstanceSpec) => ReturnType<typeof import("node:child_process").spawn> },
): Promise<LspMountHandle> {
  validateLspConfig(config)
  if (liveServerNames.has(config.serverName)) {
    throw new Error(`lsp: serverName "${config.serverName}" is already reserved by a live instance`)
  }
  liveServerNames.add(config.serverName)

  const spec: InstanceSpec = {
    command: config.command,
    args: config.args,
    cwd: config.cwd ?? ".",
    ...(config.env !== undefined ? { env: config.env } : {}),
    maxMessageBytes: config.maxMessageBytes ?? 16 * 1024 * 1024,
    maxStderrBytes: config.maxStderrBytes ?? 1_000_000,
    killGraceMs: config.killGraceMs ?? 5_000,
    shutdownTimeoutMs: config.shutdownTimeoutMs ?? 4_000,
  }
  // The instance's spawner slot takes a ConnectionSpec (broader param); the
  // injected deps.spawner narrows it to InstanceSpec — safe contravariance.
  const spawner = deps?.spawner as ((s: ConnectionSpec) => ReturnType<typeof import("node:child_process").spawn>) | undefined
  let instance: LspInstance | undefined
  try {
    // Constructed inside the try: a synchronously-throwing spawner escapes the
    // constructor before an instance exists — nothing to dispose, but the
    // reservation must still be released on the way out.
    instance = new LspInstance(spec, spawner)
    await instance.ready
    const toolConfig = { ...config, cwd: config.cwd ?? "." }
    const toolsList = createLspTools(instance, toolConfig, toolConfig.cwd)
    for (const t of toolsList) tools.register(t)
  } catch (err) {
    // Fail-closed process hygiene: a server that got as far as spawning is
    // disposed (best-effort) before the reservation is released.
    if (instance) await instance.dispose().catch(() => undefined)
    liveServerNames.delete(config.serverName)
    throw err
  }
  let unmounted = false
  return {
    serverName: config.serverName,
    async unmount() {
      // Idempotent: unmount twice (or after a failed mount) releases once —
      // the reservation dies even when dispose throws.
      if (unmounted) return
      unmounted = true
      try {
        await instance!.dispose()
      } finally {
        liveServerNames.delete(config.serverName)
        for (const name of ["lsp", "lsp_diagnostics"] as const) tools.unregister(name)
      }
    },
  }
}
