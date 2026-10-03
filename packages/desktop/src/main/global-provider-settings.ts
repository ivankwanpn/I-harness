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
export function createGlobalProviderSettings(client: () => Promise<ConfigurationClient>) {
  let closed = false
  const jobs = new Set<Promise<unknown>>()
  return {
    async request(input: unknown): Promise<unknown> {
      if (closed || !record(input)) throw new Error("Global provider settings unavailable")
      let method: string
      let params: Record<string, unknown>
      switch (input.kind) {
        case "desktop/global-preferences/state": method = "desktop/auto-title/state"; params = {}; break
        case "desktop/global-preferences/configure":
          if (typeof input.autoTitle !== "boolean") throw new Error("Invalid auto-title preference")
          method = "desktop/auto-title/configure"; params = { autoTitle: input.autoTitle }; break
        case "desktop/global-provider/directory": method = "desktop/provider/directory"; params = {}; break
        case "desktop/global-provider/mutate":
          if (!record(input.command) || !id(input.command.id) || typeof input.command.action !== "string"
            || !["provider/create", "provider/edit", "provider/remove", "key/set", "key/clear", "model/add", "model/edit", "model/remove", "default/set"].includes(input.command.action)) throw new Error("Invalid provider command")
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
        return target.request(method, params)
      })
      jobs.add(job)
      try { return await job } finally { jobs.delete(job) }
    },
    async close() { closed = true; await Promise.allSettled([...jobs]) },
  }
}
