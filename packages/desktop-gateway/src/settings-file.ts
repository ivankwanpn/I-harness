import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { acquireSessionLock } from "@i-harness/fs-lock"
import { SettingsStore } from "@i-harness/settings"

export function validateExecutionSettings(policy: Record<string, unknown>): void {
  if (policy.windowsSandboxBackend !== undefined && (typeof policy.windowsSandboxBackend !== "string" || !["legacy", "psec", "wsl"].includes(policy.windowsSandboxBackend))) throw new Error("Invalid Windows sandbox backend in settings document")
  if (policy.webSearchMode !== undefined && (typeof policy.webSearchMode !== "string" || !["disabled", "cached", "indexed", "live"].includes(policy.webSearchMode))) throw new Error("Invalid web search mode in settings document")
  if (policy.wslExecution !== undefined) {
    const value = policy.wslExecution
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid WSL execution settings")
    const input = value as Record<string, unknown>
    if (Object.keys(input).some(key => !["distribution", "networkAccess", "workspaceDependencies"].includes(key))) throw new Error("Unknown WSL execution setting")
    if (input.distribution !== undefined && (typeof input.distribution !== "string" || !input.distribution.trim() || input.distribution.length > 256 || /[\u0000-\u001f\u007f]/.test(input.distribution))) throw new Error("Invalid WSL distribution")
    for (const key of ["networkAccess", "workspaceDependencies"]) if (input[key] !== undefined && typeof input[key] !== "boolean") throw new Error(`Invalid WSL ${key}`)
  }
}

/** Cooperates with file-provider-runtime's lease; load after acquisition so a
 * settings edit cannot replace a concurrently saved provider snapshot. */
export async function withDesktopSettings<T>(path: string, work: (store: SettingsStore) => Promise<T>): Promise<T> {
  const absolute = resolve(path)
  const lockPath = `${process.platform === "win32" ? absolute.toLowerCase() : absolute}.provider.lock`
  const lock = await acquireSessionLock({ lockPath, deadlineMs: 10000 })
  try {
    let raw: string | undefined
    try { raw = await readFile(absolute, "utf8") }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Cannot read settings document") }
    if (raw !== undefined) {
      let parsed: unknown
      try { parsed = JSON.parse(raw) } catch { throw new Error("Invalid settings document") }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid settings document")
      const policy = parsed as Record<string, unknown>
      validateExecutionSettings(policy)
      if (policy.sandboxMode !== undefined && (typeof policy.sandboxMode !== "string" || !["read-only", "workspace-write", "danger-full-access"].includes(policy.sandboxMode))) throw new Error("Invalid sandbox mode in settings document")
      if (policy.approvalMode !== undefined && (typeof policy.approvalMode !== "string" || !["dangerous", "ask-all", "delegate", "full-access"].includes(policy.approvalMode))) throw new Error("Invalid approval mode in settings document")
      if (policy.approvalMode === "full-access" && policy.sandboxMode !== "danger-full-access") throw new Error("Full access requires the full-access sandbox")
    }
    const store = new SettingsStore({ path: absolute })
    await store.load()
    return await work(store)
  } finally { await lock.release() }
}
