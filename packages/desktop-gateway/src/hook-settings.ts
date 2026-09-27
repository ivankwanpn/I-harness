import { createHash } from "node:crypto"
import { dirname } from "node:path"
import { acquireSessionLock } from "@i-harness/fs-lock"
import { createHookTrustStore, loadHooksConfig, resolveHookTrustPath, trustScriptPath } from "@i-harness/hooks"

export interface HookSettingsState {
  handlers: { id: string; name: string; event: string; configPath: string; script: string; sha256: string; status: "ready" | "needs-approval" | "invalid"; error?: string }[]
  grants: { sha256: string; script: string; handlerId: string; approvedAt: string }[]
  errors: { configPath: string; message: string }[]
}
export type HookSettingsCommand = { action: "approve"; id: string; sha256: string } | { action: "revoke"; sha256: string }

export function createHookSettings(configDir: string, paths: () => Promise<string[]>, refresh: () => Promise<void>) {
  const trustPath = resolveHookTrustPath(configDir)
  async function state(): Promise<HookSettingsState> {
    const grants = createHookTrustStore(trustPath)
    const result: HookSettingsState = { handlers: [], grants: grants.list(), errors: [] }
    for (const configPath of [...new Set(await paths())]) {
      try {
        const loaded = await loadHooksConfig(configPath, dirname(configPath), grants)
        loaded.forEach(({ spec, valid, unapproved, trustError }, index) => result.handlers.push({
          id: createHash("sha256").update(JSON.stringify([configPath, spec.id, index, spec.trust.sha256])).digest("hex"),
          name: spec.id, event: spec.event, configPath, script: trustScriptPath(spec, dirname(configPath)), sha256: spec.trust.sha256,
          status: valid ? "ready" : unapproved ? "needs-approval" : "invalid", ...(trustError ? { error: trustError } : {}),
        }))
      } catch (error) { result.errors.push({ configPath, message: String(error) }) }
    }
    return result
  }
  return {
    state,
    async mutate(value: unknown) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid hook command")
      const command = value as Record<string, unknown>
      if (typeof command.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(command.sha256) || !["approve", "revoke"].includes(String(command.action))) throw new Error("Invalid hook command")
      const lock = await acquireSessionLock({ lockPath: `${trustPath}.lock`, deadlineMs: 10000 })
      try {
        const store = createHookTrustStore(trustPath)
        if (command.action === "approve") {
          if (typeof command.id !== "string") throw new Error("Hook identity required")
          const row = (await state()).handlers.find((row) => row.id === command.id && row.sha256 === command.sha256)
          if (!row || row.status === "invalid") throw new Error("Hook changed or is invalid; reload before approving")
          store.approve({ sha256: row.sha256, script: row.script, handlerId: row.name })
        } else store.revoke(command.sha256)
      } finally { await lock.release() }
      try { await refresh() } catch { throw new Error("Hook grant was saved but live refresh failed; retry refresh") }
      return state()
    },
    async refresh() { await refresh(); return state() },
  }
}
