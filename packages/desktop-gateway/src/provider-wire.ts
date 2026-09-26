import type { ProviderRuntime } from "@i-harness/provider-runtime"
import { PROVIDER_PROTOCOLS, type SettingsProviderProtocol } from "@i-harness/settings"

type ProviderFields = { displayName?: string | null; baseURL?: string | null; modelsURL?: string | null; catalog?: string | null; apiKeyEnv?: string | null; protocol?: SettingsProviderProtocol | null }
type ModelFields = { name?: string | null; contextWindow?: number | null; maxTokens?: number | null; protocol?: SettingsProviderProtocol | null }
export type ProviderCommand =
  | { action: "provider/create"; id: string; fields: ProviderFields }
  | { action: "provider/edit"; id: string; fields: ProviderFields }
  | { action: "provider/remove" | "key/clear"; id: string }
  | { action: "key/set"; id: string; value: string }
  | { action: "model/add" | "model/edit"; id: string; model: string; fields: ModelFields }
  | { action: "model/remove" | "default/set"; id: string; model: string }

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object")
  return value as Record<string, unknown>
}
function text(value: unknown, name: string, max = 256): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) throw new Error(`Invalid ${name}`)
  return value
}
function fields(value: unknown, model: boolean, allowNull: boolean): ProviderFields & ModelFields {
  const input = record(value)
  const allowed = model ? ["name", "contextWindow", "maxTokens", "protocol"] : ["displayName", "baseURL", "modelsURL", "catalog", "apiKeyEnv", "protocol"]
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(input)) {
    if (!allowed.includes(key)) throw new Error("Unknown field")
    if (item === null && allowNull) { result[key] = null; continue }
    if (key === "contextWindow" || key === "maxTokens") {
      if (typeof item !== "number" || !Number.isSafeInteger(item) || item < 1) throw new Error("Expected a positive integer")
    } else if (key === "protocol") {
      if (!(PROVIDER_PROTOCOLS as readonly unknown[]).includes(item)) throw new Error("Invalid protocol")
    } else {
      const string = text(item, key, 2048)
      if (key === "baseURL" || key === "modelsURL") {
        let url: URL
        try { url = new URL(string) } catch { throw new Error("Invalid endpoint URL") }
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid endpoint URL")
      }
    }
    result[key] = item
  }
  return result
}

/** Boundary validation only; persistence, model metadata and credentials stay in
 * provider-runtime. No arbitrary method dispatch and no credential echo. */
export async function providerCommand(runtime: ProviderRuntime, value: unknown): Promise<{ ok: true }> {
  const command = record(value)
  const id = text(command.id, "provider id", 128)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id) || ["constructor", "prototype"].includes(id)) throw new Error("Invalid provider id")
  switch (command.action) {
    case "provider/create": await runtime.createProvider(id, fields(command.fields, false, false) as Parameters<ProviderRuntime["createProvider"]>[1]); break
    case "provider/edit": await runtime.patchProvider(id, fields(command.fields, false, true)); break
    case "provider/remove": await runtime.removeProvider(id); break
    case "key/set": await runtime.setApiKey(id, text(command.value, "API key", 16384)); break
    case "key/clear": await runtime.clearApiKey(id); break
    case "model/add": await runtime.addModels(id, [{ id: text(command.model, "model id"), ...fields(command.fields, true, false) } as Parameters<ProviderRuntime["addModels"]>[1][number]]); break
    case "model/edit": await runtime.setModel(id, text(command.model, "model id"), fields(command.fields, true, true)); break
    case "model/remove": await runtime.removeModel(id, text(command.model, "model id")); break
    case "default/set": await runtime.setDefaultModel({ provider: id, model: text(command.model, "model id") }); break
    default: throw new Error("Unknown provider command")
  }
  return { ok: true }
}
