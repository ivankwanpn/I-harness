import { readFileSync } from "node:fs"
import { normalizeSettings, resolveSettingsPath } from "@i-harness/settings"

export type CliSessionStore = "jsonl" | "commit-log"

/** The store the CLI should use. Settings win over the environment, matching the
 *  Desktop host (host option > settings > IH_SESSION_STORE > legacy). A missing
 *  or corrupt settings file falls through to the environment. */
export function cliSessionStore(): CliSessionStore {
  try {
    const settings = normalizeSettings(JSON.parse(readFileSync(resolveSettingsPath({}), "utf8")))
    if (settings.sessionStore !== undefined) return settings.sessionStore
  } catch { /* absent/corrupt settings are not an error for store selection */ }
  return process.env.IH_SESSION_STORE === "commit-log" ? "commit-log" : "jsonl"
}
