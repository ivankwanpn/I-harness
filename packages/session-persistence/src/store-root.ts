import { join } from "node:path"
import { resolveHarnessHome } from "@i-harness/harness-home"

/**
 * M61: the DURABLE session-store root a host uses when no explicit
 * `--session-dir` was given: `<harness home>/sessions`.
 *
 * Before this the TUI only persisted when `--session-dir` was on the command
 * line (a bare launch ran the embedded factory's ephemeral session, so the
 * picker listed nothing and `--resume` was impossible) and the CLI had no way
 * to point at the store at all. Both now default here.
 *
 * The home itself is not resolved here any more: `@i-harness/harness-home` owns
 * that, because four packages used to answer the question independently and one
 * of them dropped `$IH_CONFIG_DIR`. What stays here is `"sessions"` — the
 * subdirectory name is this package's own regional knowledge.
 */
export function resolveSessionStoreRoot(options: { configDir?: string } = {}): string {
  return join(resolveHarnessHome(options.configDir), "sessions")
}
