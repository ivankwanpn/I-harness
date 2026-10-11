import { createHash } from "node:crypto"
import type { CodexManagement } from "@i-harness/coding-plans"
import type { ProviderRuntime } from "@i-harness/provider-runtime"

const accountKey = (id: string) => `codex-${createHash("sha256").update(id).digest("hex").slice(0, 24)}`
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256 || /[\u0000-\u001f]/.test(value)) throw new Error("Invalid Coding Plans selection")
  return value
}

/** One Codex subscription identity owns model traffic, allowance and reset cards. */
export function createCodingPlans(codex: CodexManagement, provider: ProviderRuntime, options: { now?: () => number } = {}) {
  const discovered = new Set<string>()
  const usageAttempts = new Map<string, number>()
  const now = options.now ?? Date.now
  let tail: Promise<unknown> = Promise.resolve()
  let closed = false
  async function state() {
    const snapshot = await codex.state()
    const accounts = snapshot.accountId ? [{
      id: snapshot.accountId, provider: "openai-codex" as const, email: snapshot.email,
      status: snapshot.status === "connected" ? "connected" as const : "reauth-required" as const,
      models: snapshot.models ?? [],
    }] : []
    for (const account of accounts) {
      if (account.status !== "connected") continue
      const id = accountKey(account.id)
      const current = (await provider.directory()).find(row => row.id === id)
      if (current?.oauthAccountId === account.id) {
        // Model choices and overrides belong to Models and providers. Reading
        // account/quota state must not rewrite the user's configured catalog.
        continue
      }
      if (current) throw new Error("Codex account provider identity conflicts with an existing route")
      await provider.upsertProvider(id, {
        displayName: `Codex subscription · ${account.email ?? "OpenAI"}`,
        protocol: "openai-responses", baseURL: "https://chatgpt.com/backend-api/codex", catalog: "openai",
        oauthProvider: "openai-codex", oauthAccountId: account.id, models: account.models,
      })
    }
    return { accounts, welcomePending: false, openaiManagement: snapshot,
      ...(snapshot.status === "pending" ? { login: { status: "pending" as const } } : {}),
      ...(snapshot.message ? { message: snapshot.message } : {}),
    }
  }
  async function request(method: string, input: unknown) {
    if (closed) throw new Error("Coding Plans is closed")
    const params = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {}
    switch (method) {
      case "desktop/coding-plans/state": {
        const snapshot = await codex.state()
        if (snapshot.status === "connected" && snapshot.accountId && !snapshot.models?.length && !discovered.has(snapshot.accountId)) {
          discovered.add(snapshot.accountId)
          try { await codex.models(snapshot.accountId) } catch { /* Explicit Refresh models remains available. */ }
        }
        if (snapshot.status === "connected" && snapshot.accountId) {
          const attemptedAt = usageAttempts.get(snapshot.accountId)
          if (attemptedAt === undefined || now() - attemptedAt >= 60_000) {
            usageAttempts.set(snapshot.accountId, now())
            // The account service persists a redacted failure state. Returning
            // that state keeps sign-out/reauth available when quota is offline.
            try { await codex.refresh() } catch { /* Retry on the next TTL or explicit refresh. */ }
          }
        }
        return state()
      }
      case "desktop/coding-plans/start":
        await codex.start()
        discovered.clear(); usageAttempts.clear()
        return { authorizationUrl: "https://auth.openai.com/codex/device" }
      case "desktop/coding-plans/cancel": await codex.cancel(); return state()
      case "desktop/coding-plans/welcome-dismiss": return state()
      case "desktop/coding-plans/refresh": {
        const accountId = text(params.accountId)
        const models = await codex.models(accountId)
        await state()
        await provider.replaceSubscriptionModels(accountKey(accountId), accountId, models)
        return state()
      }
      case "desktop/coding-plans/signout": {
        if ((await codex.state()).accountId !== text(params.accountId)) throw new Error("Codex account changed")
        await codex.signOut(text(params.accountId)); discovered.delete(text(params.accountId)); usageAttempts.delete(text(params.accountId)); return state()
      }
      case "desktop/coding-plans/management-refresh": {
        const snapshot = await codex.state()
        if (snapshot.accountId) usageAttempts.set(snapshot.accountId, now())
        await codex.refresh(); return state()
      }
      case "desktop/coding-plans/reset-credit":
        if (params.confirmed !== true) throw new Error("Reset credit requires explicit confirmation")
        await codex.redeem({ accountId: text(params.accountId), creditId: text(params.creditId), confirmed: true })
        return state()
      default: throw new Error("Unknown Coding Plans operation")
    }
  }
  return {
    request(method: string, params: unknown): Promise<unknown> {
      const job = tail.then(() => request(method, params))
      tail = job.catch(() => undefined)
      return job
    },
    async close() { closed = true; await codex.close(); await tail },
  }
}
