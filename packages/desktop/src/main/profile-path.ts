import { existsSync } from "node:fs"
import { join, resolve } from "node:path"

/** Reuse existing Desktop history after the product rename; never move data. */
export function resolveDesktopProfilePath(appData: string, userData: string, exists: (path: string) => boolean = existsSync, explicitlySelected = false): string {
  if (explicitlySelected) return userData
  const current = join(appData, "I-harness")
  // Explicit data directories, including owned QA profiles, remain authoritative.
  if (resolve(userData).toLowerCase() !== resolve(current).toLowerCase()) return userData
  const hasHistory = (root: string) => exists(join(root, "workspaces.json")) || exists(join(root, "sessions"))
  if (hasHistory(current)) return userData
  const legacy = join(appData, "I-harness Desktop")
  return hasHistory(legacy) ? legacy : userData
}
