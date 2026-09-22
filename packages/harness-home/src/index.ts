import { homedir } from "node:os"
import { join } from "node:path"

/**
 * The harness home — `$IH_CONFIG_DIR` when set, else `~/.i-harness`.
 *
 * WHY THIS IS ITS OWN PACKAGE. Every subsystem hangs a path off the home:
 * `settings.json`, `hooks.json`, `skills/`, `plugins/`, `sessions/`. The value was
 * previously resolved in FOUR places — a private copy in `session-persistence`, an
 * inline copy in `settings`, an inline copy in `hooks`, and a fourth in `skills`
 * that dropped the environment variable entirely. That last one is the defect this
 * package exists to make impossible: `$IH_CONFIG_DIR` is the isolation contract
 * (e2e/helpers.ts:29), so a test that pinned it to a temp directory still read the
 * developer's real `~/.i-harness` through the copy that ignored it.
 *
 * A LEAF on purpose: zero workspace dependencies, so any package may depend on it
 * without a cycle. And it knows nothing about the subdirectories its callers build
 * — `join(resolveHarnessHome(), "skills")` belongs to the skills package, because
 * only that package should know its directory is called `skills`. This module must
 * not grow a list of subdirectories; that is how a shared path helper becomes a
 * god module.
 *
 * Resolved PER CALL: a module-level binding would capture the environment once, at
 * import, so a process that sets the variable afterwards — or a test that isolates
 * by setting it — would be silently ignored.
 *
 * The chain is `??`, not `||`: an explicitly empty `configDir` is a caller error to
 * surface, not a silent fall-through to the environment.
 */
export function resolveHarnessHome(configDir?: string): string {
  return configDir ?? process.env.IH_CONFIG_DIR ?? join(homedir(), ".i-harness")
}
