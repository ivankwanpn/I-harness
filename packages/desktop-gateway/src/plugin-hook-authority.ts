import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { dirname } from "node:path"
import { sha256ClaudePluginTreeSync, trustScriptPath, type HookRegistry } from "@i-harness/hooks"

/** Source adapters have already produced canonical HookHandlerSpec entries.
 * No source-format logic or inferred capability appears on this authority path. */
export function fingerprintHookArtifacts(configPath: string, registry: HookRegistry, pluginRoot?: string) {
  const handlers = registry.handlers()
  const scripts = handlers.map(({ spec }) => {
    const path = trustScriptPath(spec, dirname(configPath))
    return [path, createHash("sha256").update(readFileSync(path)).digest("hex")]
  })
  return { handlers, scripts, ...(pluginRoot ? { pluginRoot, pluginTree: sha256ClaudePluginTreeSync(pluginRoot) } : {}) }
}
