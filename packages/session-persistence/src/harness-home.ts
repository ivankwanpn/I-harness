import { homedir } from "node:os"
import { join } from "node:path"

/**
 * M61: the harness config home — `$IH_CONFIG_DIR` when set, else
 * `~/.i-harness`. The settings document and every store hang off it, so hosts
 * that need a default path agree by construction instead of each inventing one.
 */
export function resolveHarnessHome(configDir?: string): string {
  return configDir ?? process.env.IH_CONFIG_DIR ?? join(homedir(), ".i-harness")
}

/**
 * M61: the DURABLE session-store root a host uses when no explicit
 * `--session-dir` was given: `<harness home>/sessions`.
 *
 * Before this the TUI only persisted when `--session-dir` was on the command
 * line (a bare launch ran the embedded factory's ephemeral session, so the
 * picker listed nothing and `--resume` was impossible) and the CLI had no way
 * to point at the store at all. Both now default here.
 */
export function resolveSessionStoreRoot(options: { configDir?: string } = {}): string {
  return join(resolveHarnessHome(options.configDir), "sessions")
}
