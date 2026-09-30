import { readFileSync } from "node:fs"
import { normalizeSettings, PROVIDER_PROTOCOLS, type Settings } from "@i-harness/settings"
import { builtinRoles } from "@i-harness/subagent"
import { withDesktopSettings } from "./settings-file.ts"

type Selection = Settings["agents"]["roles"][string]
export type SubagentSettingsCommand = { action: "enable"; enabled: boolean } | { action: "role/clear"; role: string } | { action: "role/set"; role: string; selection: Selection }
export interface SubagentSettingsState {
  enabled: boolean
  effectiveEnabled: boolean
  restartRequired: boolean
  roles: { name: string; description?: string; selection?: Selection }[]
}
function name(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value) || ["constructor", "prototype"].includes(value)) throw new Error("Invalid role or provider name")
  return value
}
function selection(value: unknown): Selection {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid role model")
  const row = value as Record<string, unknown>
  if (Object.keys(row).some((key) => !["provider", "model", "protocol", "reasoningEffort"].includes(key))) throw new Error("Unknown role model field")
  const provider = name(row.provider)
  if (typeof row.model !== "string" || !row.model.trim() || row.model.length > 256 || row.model.includes("\0")) throw new Error("Invalid model")
  if (row.protocol !== undefined && !(PROVIDER_PROTOCOLS as readonly unknown[]).includes(row.protocol)) throw new Error("Invalid protocol")
  if (row.reasoningEffort !== undefined && (typeof row.reasoningEffort !== "string" || !row.reasoningEffort.trim() || row.reasoningEffort.length > 64)) throw new Error("Invalid reasoning effort")
  return { provider, model: row.model, ...(row.protocol === undefined ? {} : { protocol: row.protocol as Selection["protocol"] }), ...(row.reasoningEffort === undefined ? {} : { reasoningEffort: row.reasoningEffort as string }) }
}
export function createSubagentSettings(path: string, effectiveEnabled: boolean) {
  function stateOf(settings: Settings): SubagentSettingsState {
    const builtins = [...builtinRoles(), { name: "reviewer", description: "Approval reviewer: assesses tool calls using its own selected model." }]
    const roles = settings.agents.roles
    return { enabled: settings.plugins.subagentModel, effectiveEnabled, restartRequired: settings.plugins.subagentModel !== effectiveEnabled,
      roles: [...new Set([...builtins.map((role) => role.name), ...Object.keys(roles)])].map((name) => ({ name, description: builtins.find((role) => role.name === name)?.description, ...(Object.hasOwn(roles, name) ? { selection: roles[name] } : {}) })) }
  }
  return {
    state: () => withDesktopSettings(path, async (store) => stateOf(store.get())),
    // The executor's role callback is synchronous. Read only at a spawn/resume
    // boundary, so even another gateway's atomic write is visible immediately;
    // no watcher, renderer authority or second role registry is introduced.
    selectionFor(role: string): Selection | undefined {
      let raw: unknown
      try { raw = JSON.parse(readFileSync(path, "utf8")) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new Error("Cannot read subagent model settings") }
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid subagent model settings")
      const roles = normalizeSettings(raw).agents.roles
      return Object.hasOwn(roles, role) ? roles[role] : undefined
    },
    async mutate(value: unknown) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid subagent settings command")
      const command = value as Record<string, unknown>
      if (command.action === "enable") {
        if (typeof command.enabled !== "boolean") throw new Error("Invalid enabled flag")
        return withDesktopSettings(path, async (store) => stateOf(await store.set({ plugins: { ...store.get().plugins, subagentModel: command.enabled as boolean } })))
      }
      if (command.action !== "role/set" && command.action !== "role/clear") throw new Error("Unknown subagent command")
      const role = name(command.role)
      const next = command.action === "role/set" ? selection(command.selection) : undefined
      return withDesktopSettings(path, async (store) => {
        const roles = { ...store.get().agents.roles }
        if (next) roles[role] = next; else delete roles[role]
        return stateOf(await store.set({ agents: { roles } }))
      })
    },
  }
}
