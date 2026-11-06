import { readFileSync } from "node:fs"
import { normalizeSettings, resolveSettingsPath } from "@i-harness/settings"

export type CliSessionStore = "jsonl" | "commit-log"

let override: CliSessionStore | undefined

/** Set by the top-level `--session-store` parse; applies to every coordinator
 *  this process builds (run/sdk/acp). */
export function setCliSessionStoreOverride(value: CliSessionStore | undefined): void {
  override = value === "jsonl" || value === "commit-log" ? value : undefined
}

/** The store the CLI should use: explicit flag > settings > environment > legacy.
 *  The Desktop host uses the same precedence, with its own option above the flag. */
export function cliSessionStore(explicit?: CliSessionStore): CliSessionStore {
  const chosen = explicit === "jsonl" || explicit === "commit-log" ? explicit : override
  if (chosen !== undefined) return chosen
  try {
    const settings = normalizeSettings(JSON.parse(readFileSync(resolveSettingsPath({}), "utf8")))
    if (settings.sessionStore !== undefined) return settings.sessionStore
  } catch { /* absent/corrupt settings are not an error for store selection */ }
  return process.env.IH_SESSION_STORE === "commit-log" ? "commit-log" : "jsonl"
}
