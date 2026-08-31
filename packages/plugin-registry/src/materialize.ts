/**
 * enable() materialization: a plugin's skills/ and commands/ trees are copied
 * into `<root>/skills/<id>` and `<root>/commands/<id>` — the host's read-only
 * overlays. mcp needs no materialization: the runtime reads the re-keyed
 * .mcp.json out of the installed copy itself.
 *
 * The target dirs are removed before the copy, so stale files of a previous
 * version never linger. A failure leaves the state untouched — enable() writes
 * state only after materialization succeeds (no partial enable); the next
 * attempt removes the half-copied dir first. Directories the plugin does not
 * have (skills/ or commands/ absent) are simply not materialized.
 *
 * Plugin code is never executed here — this is a plain directory copy.
 */

import { existsSync } from "node:fs"
import { cp, rm } from "node:fs/promises"
import { join } from "node:path"

/** Materialized locations of one enabled plugin (dangling if the plugin does
 * not carry the corresponding tree). */
export interface MaterializedPlugin {
  skillDir: string
  commandDir: string
}

export async function materializePlugin(
  installPath: string,
  id: string,
  root: string,
): Promise<MaterializedPlugin> {
  const skillDir = join(root, "skills", id)
  const commandDir = join(root, "commands", id)
  await rm(skillDir, { recursive: true, force: true })
  await rm(commandDir, { recursive: true, force: true })
  const skillsSource = join(installPath, "skills")
  if (existsSync(skillsSource)) await cp(skillsSource, skillDir, { recursive: true })
  const commandsSource = join(installPath, "commands")
  if (existsSync(commandsSource)) await cp(commandsSource, commandDir, { recursive: true })
  return { skillDir, commandDir }
}
