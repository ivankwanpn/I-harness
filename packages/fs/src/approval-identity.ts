import { createHash } from "node:crypto"
import { lstatSync, realpathSync } from "node:fs"
import { isAbsolute, join, parse, relative, resolve } from "node:path"
import type { PreparedToolIdentity } from "@i-harness/core-tools"

/** Permission evidence names the real workspace and every target ancestor.
 * No traversal, symlinks/junctions, special files or missing parent chains. */
export function filesystemApprovalIdentity(workspace: string, path: string, operation: "read" | "write" | "edit" | "list_dir", implementation: string): PreparedToolIdentity | undefined {
  try {
    if (!path || path.length > 4096 || path.split(/[\\/]/).includes("..") || path.replace(/^[A-Za-z]:/, "").includes(":")) return undefined
    const root = resolve(workspace); const target = resolve(root, path)
    const rel = relative(root, target)
    if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) return undefined
    if (relative(realpathSync(root), root) !== "") return undefined
    const segments = target.slice(parse(target).root.length).split(/[\\/]/).filter(Boolean)
    if (segments.length > 64) return undefined
    let current = parse(target).root
    const chain: { path: string; dev: string; ino: string; type: string }[] = []
    for (let index = 0; index < segments.length; index++) {
      current = join(current, segments[index]!)
      let stat
      try { stat = lstatSync(current, { bigint: true }) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && index === segments.length - 1 && operation === "write") { chain.push({ path: current, dev: "", ino: "", type: "missing" }); break }
        return undefined
      }
      if (stat.isSymbolicLink() || !(stat.isDirectory() || stat.isFile())) return undefined
      if (stat.isFile() && (stat.nlink > 1n || stat.ino === 0n)) return undefined
      if (index < segments.length - 1 && !stat.isDirectory()) return undefined
      if (index === segments.length - 1 && (operation === "list_dir" ? !stat.isDirectory() : !stat.isFile())) return undefined
      chain.push({ path: current, dev: String(stat.dev), ino: String(stat.ino), type: stat.isDirectory() ? "directory" : "file" })
    }
    if (!chain.length) return undefined
    return { binding: JSON.stringify({ version: 1, operation, root, target, chain, implementation: createHash("sha256").update(implementation).digest("hex") }), executablePaths: [process.execPath] }
  } catch { return undefined }
}
