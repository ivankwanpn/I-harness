import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { parseCommandMarkdown, type CommandDescriptor, type RuntimeInputs } from "@i-harness/plugin-registry"
import { assertResourcePath, readResourceFile, validateResourceName } from "./resource-files.ts"

export type LocalResourceSource = "workspace" | "global"
export interface EffectiveCommandDescriptor extends CommandDescriptor { source?: LocalResourceSource | "plugin"; path?: string }
export interface EffectiveRuntimeInputs extends RuntimeInputs { commandDescriptors: EffectiveCommandDescriptor[]; commandLayers: EffectiveCommandDescriptor[]; diagnostics: string[] }
export const authoredHookPath = (workspace: string, configDir: string, source: LocalResourceSource) => source === "workspace" ? join(workspace, ".i-harness", "hooks", "hooks.json") : join(configDir, "hooks", "authored", "hooks.json")

/** Feed this result to pluginExtensions and the resource/slash catalogues on every build/refresh. */
export function createEffectiveLocalInputs(workspace: string, configDir: string, input: RuntimeInputs): EffectiveRuntimeInputs {
  const diagnostics: string[] = []
  const commands = new Map<string, EffectiveCommandDescriptor>()
  const commandLayers: EffectiveCommandDescriptor[] = []
  const scan = (source: LocalResourceSource) => {
    const root = source === "workspace" ? workspace : configDir, dir = join(root, "commands")
    if (!existsSync(dir)) return
    try {
      assertResourcePath(root, dir)
      let count = 0
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.name.endsWith(".md")) continue
        if (++count > 256) { diagnostics.push(`${source}: command entry cap reached`); break }
        try {
          validateResourceName(entry.name.slice(0, -3))
          const path = join(dir, entry.name), file = readResourceFile(root, path)
          if (file) { const row = { ...parseCommandMarkdown(entry.name, file.body), source, path }; commands.set(row.name, row); commandLayers.push(row) }
        } catch (error) { if (diagnostics.length < 100) diagnostics.push(`${source} ${entry.name}: ${String(error)}`) }
      }
    } catch (error) { diagnostics.push(String(error)) }
  }
  scan("global")
  for (const row of input.commandDescriptors) { const descriptor = { ...row, source: "plugin" as const }; commands.set(row.name, descriptor); commandLayers.push(descriptor) }
  scan("workspace")
  const hookConfigs = [...input.hookConfigs]
  for (const source of ["global", "workspace"] as const) {
    const path = authoredHookPath(workspace, configDir, source), root = source === "workspace" ? workspace : configDir
    if (!existsSync(path)) continue
    try { if (readResourceFile(root, path)) hookConfigs.push(path) } catch (error) { diagnostics.push(String(error)) }
  }
  return { ...input, commandDescriptors: [...commands.values()].sort((a, b) => a.name.localeCompare(b.name)), commandLayers, hookConfigs: [...new Set(hookConfigs)], diagnostics }
}
