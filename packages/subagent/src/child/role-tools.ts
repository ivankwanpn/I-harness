import type { ToolRegistry } from "@i-harness/core-tools"
import { d } from "./diagnostics.ts"

/**
 * Register a role's declared tools onto a child registry, resolved from the
 * parent. Returns the declared names that resolved to NOTHING.
 *
 * The drop is reported rather than performed in silence. A role's `tools` list
 * is a RESTRICTION — the child gets exactly these and no others — so a name
 * that matches no mounted tool silently narrows the child below what its role
 * declares, and no surface showed it: the role registered, the table listed it,
 * and the agent simply could not do the thing. (Two identical copies of the
 * silent loop lived in child.ts and tools.ts; a plugin agent declaring Claude
 * Code's `Read`/`Glob`/`Grep` vocabulary against this repo's lowercase registry
 * would have hit it on every entry.)
 *
 * Deliberately a warn, NOT a throw — unlike the unknown-provider case a few
 * lines below, which does throw. The two look symmetric but are not: a role
 * naming a provider that does not exist cannot run at all, whereas a role with
 * ONE unmounted tool still runs and simply has less to work with. A host that
 * mounts no `pwsh` must still be able to spawn its builtin roles.
 */
export function resolveRoleTools(
  roleName: string,
  declared: string[],
  parent: ToolRegistry,
  child: ToolRegistry,
): string[] {
  const missing: string[] = []
  for (const name of declared) {
    // Code Mode wrappers close over their owning registry/session. Each child
    // mounts these separately through the host factory below.
    if (name === "code_exec" || name === "code_wait") continue
    const tool = parent.get(name)
    if (tool) {
      child.register(tool)
      // The role has already selected these exact bindings. A child has no
      // parent discovery tool, so expose its allowed deferred schemas locally
      // without cloning bindings or promoting anything in the parent.
      child.promote([name])
    }
    else missing.push(name)
  }
  if (missing.length > 0) {
    d.warn(
      `[subagent] role '${roleName}' declares ${missing.length} tool(s) absent from the parent registry; ` +
        `the child runs without them: ${missing.join(", ")}`,
    )
  }
  return missing
}
