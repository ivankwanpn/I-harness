import type { ProviderCommand } from "@i-harness/desktop-gateway/src/provider-wire.ts"

export type GlobalProviderRequest =
  | { kind: "desktop/global-provider/directory" }
  | { kind: "desktop/global-provider/mutate"; command: ProviderCommand }
  | { kind: "desktop/global-provider/probe"; id: string; token: string }
  | { kind: "desktop/global-provider/probe/cancel"; token: string }
export type GlobalPreferencesRequest =
  | { kind: "desktop/global-preferences/state" }
  | { kind: "desktop/global-preferences/configure"; autoTitle: boolean }
export interface ConfigurationClient { request(method: string, params: Record<string, unknown>): Promise<unknown> }

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 128 && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value) && !["constructor", "prototype"].includes(value)
const token = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value)

/** A configuration-only gateway has no catalog workspace or conversation. Its
 * provider runtime uses the same settings/credentials as later workspace hosts.
 * Keeping these operations in that shipped gateway avoids raw TS dependencies
 * entering Electron main. Provider endpoint probes remain explicit UI actions. */
export function createGlobalProviderSettings(client: () => Promise<ConfigurationClient>, options: { openExternal?(url: string): Promise<void>; usageWarnings?(): Promise<string[]> } = {}) {
  let closed = false
  const jobs = new Set<Promise<unknown>>()
  return {
    async request(input: unknown): Promise<unknown> {
      if (closed || !record(input)) throw new Error("Global provider settings unavailable")
      let method: string
      let params: Record<string, unknown>
      switch (input.kind) {
        case "desktop/usage/query":
          if (!record(input.query)) throw new Error("Invalid usage query")
          method = input.kind; params = { query: input.query }; break
        case "desktop/usage/pricing":
          if (!record(input.price)) throw new Error("Invalid usage pricing")
          method = input.kind; params = { price: input.price }; break
        case "desktop/coding-plans/state":
        case "desktop/coding-plans/cancel":
        case "desktop/coding-plans/welcome-dismiss":
        case "desktop/coding-plans/management-refresh":
          method = input.kind; params = {}; break
        case "desktop/coding-plans/reset-credit":
          if (!token(input.accountId) || !token(input.creditId) || input.confirmed !== true) throw new Error("Reset credit requires an account, card and explicit confirmation")
          method = input.kind; params = { accountId: input.accountId, creditId: input.creditId, confirmed: true }; break
        case "desktop/coding-plans/start":
          if (input.accountId !== undefined && !id(input.accountId)) throw new Error("Invalid Coding Plans account")
          method = input.kind; params = input.accountId ? { accountId: input.accountId } : {}; break
        case "desktop/coding-plans/refresh":
        case "desktop/coding-plans/signout":
          if (!id(input.accountId)) throw new Error("Invalid Coding Plans account")
          method = input.kind; params = { accountId: input.accountId }; break
        case "desktop/global-preferences/state": method = "desktop/auto-title/state"; params = {}; break
        case "desktop/global-retry/state": method = "desktop/model-retry/state"; params = {}; break
        case "desktop/global-retry/configure":
          if (typeof input.maxRetries !== "number" || !Number.isSafeInteger(input.maxRetries) || input.maxRetries < 0 || input.maxRetries > 100) throw new Error("Invalid model retry limit")
          method = "desktop/model-retry/configure"; params = { maxRetries: input.maxRetries }; break
        case "desktop/global-preferences/configure":
          if (typeof input.autoTitle !== "boolean") throw new Error("Invalid auto-title preference")
          method = "desktop/auto-title/configure"; params = { autoTitle: input.autoTitle }; break
        case "desktop/global-provider/directory": method = "desktop/provider/directory"; params = {}; break
        case "desktop/global-provider/mutate":
          if (!record(input.command) || !id(input.command.id) || typeof input.command.action !== "string"
            || !["provider/create", "provider/edit", "provider/remove", "key/set", "key/clear", "model/add", "model/edit", "model/remove", "default/set", "video-audio/set"].includes(input.command.action)) throw new Error("Invalid provider command")
          method = "desktop/provider/mutate"; params = input.command; break
        case "desktop/global-provider/probe":
          if (!id(input.id) || !token(input.token)) throw new Error("Invalid provider probe")
          method = "desktop/provider/probe"; params = { id: input.id, token: input.token }; break
        case "desktop/global-provider/probe/cancel":
          if (!token(input.token)) throw new Error("Invalid provider probe token")
          method = "desktop/provider/probe/cancel"; params = { token: input.token }; break
        default: throw new Error("Unknown global provider request")
      }
      const job = Promise.resolve().then(async () => {
        if (closed) throw new Error("Global provider settings closed")
        const target = await client()
        if (closed) throw new Error("Global provider settings closed")
        if (method === "desktop/coding-plans/start") {
          if (!options.openExternal) throw new Error("Browser opening unavailable")
          const result = await target.request(method, params)
          try {
            if (!record(result) || typeof result.authorizationUrl !== "string") throw new Error()
            const url = new URL(result.authorizationUrl)
            if (closed || url.href !== "https://auth.openai.com/codex/device") throw new Error()
            await options.openExternal(url.href)
          } catch {
            await target.request("desktop/coding-plans/cancel", {}).catch(() => {})
            throw new Error("Unable to open ChatGPT authorization. Please try again.")
          }
          return target.request("desktop/coding-plans/state", {})
        }
        const result = await target.request(method, params)
        if (method === "desktop/usage/query" && record(result) && options.usageWarnings) {
          const warnings = await options.usageWarnings()
          return { ...result, warnings: [...new Set([...(Array.isArray(result.warnings) ? result.warnings : []), ...warnings])] }
        }
        return result
      })
      jobs.add(job)
      try { return await job } finally { jobs.delete(job) }
    },
    async close() { closed = true; await Promise.allSettled([...jobs]) },
  }
}
