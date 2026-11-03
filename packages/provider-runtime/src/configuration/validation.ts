import type { SettingsProviderConfig, SettingsProviderProtocol } from "@i-harness/settings"

/** The route fields `patchProvider` may change — a RUNTIME allowlist, not only
 * a type. `models` is absent ON PURPOSE (see the method), and a type cannot
 * enforce that here: the patch arrives as a variable, so TypeScript's
 * excess-property check never runs. */
export const PATCHABLE_PROVIDER_FIELDS = ["baseURL", "protocol", "catalog", "displayName", "modelsURL", "apiKeyEnv", "promptCache"] as const

/** Validate before resolving any bearer credential, including hand-edited settings. */
export function validateChatGptRoute(config: SettingsProviderConfig, protocol?: SettingsProviderProtocol): void {
  if (!config.oauthAccountId) return
  if (!/^[a-zA-Z0-9._-]{1,128}$/.test(config.oauthAccountId)
    || config.protocol !== "openai-responses" || (protocol !== undefined && protocol !== "openai-responses")
    || config.oauthProvider !== "openai-codex"
    || (config.baseURL !== undefined && config.baseURL !== "https://chatgpt.com/backend-api/codex")
    || config.modelsURL !== undefined
    || config.apiKeyEnv !== undefined || Object.keys(config.headers ?? {}).length > 0
    || config.models?.some(model => model.protocol !== undefined && model.protocol !== "openai-responses")) {
    throw new Error("ChatGPT Codex subscription requires its Codex Responses endpoint and account authorization")
  }
}

export function providerApiKeyRef(id: string): string {
  let normalized = id.toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
  if (normalized === "") normalized = "PROVIDER"
  if (/^[0-9]/.test(normalized)) normalized = `PROVIDER_${normalized}`
  return `${normalized}_API_KEY`
}

export function assertProviderId(id: string): void {
  if (id.trim() === "") throw new Error("provider id is required")
}
