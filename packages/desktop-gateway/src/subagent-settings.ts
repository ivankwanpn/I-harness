import { readFileSync } from "node:fs"
import { normalizeSettings, PROVIDER_PROTOCOLS, type Settings } from "@i-harness/settings"
import { builtinRoles } from "@i-harness/subagent"
import { withDesktopSettings } from "./settings-file.ts"

type Selection = Settings["agents"]["roles"][string]
export type SubagentSettingsCommand = { action: "enable"; enabled: boolean } | { action: "role/clear"; role: string } | { action: "role/set"; role: string; selection: Selection } | { action: "role/tools"; role: string; tools: string[] }
export interface SubagentSettingsState {
  enabled: boolean
  effectiveEnabled: boolean
  restartRequired: boolean
  roles: { name: string; description?: string; selection?: Selection; tools: string[] }[]
  /** Selectable builtin tools, grouped for the role editor. */
  toolGroups: { id: string; label: string; tools: string[] }[]
}

/** Builtin tool groups the role editor exposes. Tool names are the registry's
 * own; a role's explicit list may also name anything else the host mounts. */
export const ROLE_TOOL_GROUPS: readonly { id: string; label: string; tools: string[] }[] = [
  { id: "read", label: "讀取檔案", tools: ["read", "list_dir", "grep", "glob"] },
  { id: "write", label: "寫入檔案", tools: ["write"] },
  { id: "shell", label: "執行命令", tools: ["bash", "pwsh", "shell"] },
  { id: "web", label: "網頁（webfetch／websearch）", tools: ["webfetch", "websearch"] },
  { id: "context", label: "Context／Code Context", tools: ["context_output_search", "context_output_read", "context_output_status", "code_context_search", "code_context_status", "code_context_index"] },
  { id: "agent", label: "再生成子代理", tools: ["spawn_agent"] },
]
function name(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value) || ["constructor", "prototype"].includes(value)) throw new Error("Invalid role or provider name")
  return value
}
function selection(value: unknown): Selection {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid role model")
  const row = value as Record<string, unknown>
  if (Object.keys(row).some((key) => !["provider", "model", "protocol", "reasoningEffort", "tools"].includes(key))) throw new Error("Unknown role model field")
  const provider = name(row.provider)
  if (typeof row.model !== "string" || !row.model.trim() || row.model.length > 256 || row.model.includes("\0")) throw new Error("Invalid model")
  if (row.protocol !== undefined && !(PROVIDER_PROTOCOLS as readonly unknown[]).includes(row.protocol)) throw new Error("Invalid protocol")
  if (row.reasoningEffort !== undefined && (typeof row.reasoningEffort !== "string" || !row.reasoningEffort.trim() || row.reasoningEffort.length > 64)) throw new Error("Invalid reasoning effort")
  return { provider, model: row.model, ...(row.protocol === undefined ? {} : { protocol: row.protocol as Selection["protocol"] }), ...(row.reasoningEffort === undefined ? {} : { reasoningEffort: row.reasoningEffort as string }) }
}
export function createSubagentSettings(path: string, effectiveEnabled: boolean, options: { onEnabledChanged?: (enabled: boolean) => void } = {}) {
  function stateOf(settings: Settings): SubagentSettingsState {
    if (settings.plugins.subagentModel !== effectiveEnabled && options.onEnabledChanged) {
      options.onEnabledChanged(settings.plugins.subagentModel)
      effectiveEnabled = settings.plugins.subagentModel
    }
    const builtins: { name: string; description?: string; tools?: string[] }[] = [...builtinRoles(), { name: "reviewer", description: "Approval reviewer: assesses tool calls using its own selected model.", tools: [] }]
    const roles = settings.agents.roles
    return { enabled: settings.plugins.subagentModel, effectiveEnabled, restartRequired: settings.plugins.subagentModel !== effectiveEnabled,
      roles: [...new Set([...builtins.map((role) => role.name), ...Object.keys(roles)])].map((name) => ({ name, description: builtins.find((role) => role.name === name)?.description, ...(Object.hasOwn(roles, name) ? { selection: roles[name] } : {}), tools: settings.agents.roleTools?.[name] ?? builtins.find((role) => role.name === name)?.tools ?? [] })), toolGroups: ROLE_TOOL_GROUPS.map((group) => ({ ...group, tools: [...group.tools] })) }
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
      if (command.action === "role/tools") {
        const role = name(command.role)
        if (!Array.isArray(command.tools) || command.tools.length > 256) throw new Error("Invalid role tools")
        const tools = [...new Set(command.tools.map((tool) => {
          if (typeof tool !== "string" || !/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(tool)) throw new Error("Invalid role tools")
          return tool
        }))]
        return withDesktopSettings(path, async (store) => {
          const agents = store.get().agents
          const roleTools = { ...(agents.roleTools ?? {}) }
          if (tools.length === 0) delete roleTools[role]; else roleTools[role] = tools
          return stateOf(await store.set({ agents: { roles: agents.roles, ...(Object.keys(roleTools).length === 0 ? {} : { roleTools }) } }))
        })
      }
      if (command.action !== "role/set" && command.action !== "role/clear") throw new Error("Unknown subagent command")
      const role = name(command.role)
      const next = command.action === "role/set" ? selection(command.selection) : undefined
      return withDesktopSettings(path, async (store) => {
        const agents = store.get().agents
        const roles = { ...agents.roles }
        const roleTools = { ...(agents.roleTools ?? {}) }
        if (next) roles[role] = next; else { delete roles[role]; delete roleTools[role] }
        return stateOf(await store.set({ agents: { roles, ...(Object.keys(roleTools).length === 0 ? {} : { roleTools }) } }))
      })
    },
  }
}