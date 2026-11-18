import { createHash } from "node:crypto"
import { lstatSync, realpathSync } from "node:fs"
import { isAbsolute, join, parse, relative, resolve } from "node:path"
import type { PreparedToolIdentity } from "@i-harness/core-tools"

/**
 * Implementation identity for remembered approvals. This used to hash the
 * `Function.prototype.toString()` of seventeen functions on every
 * `createFsTools()` call: expensive, unstable across bundlers/minifiers (a
 * build-tool change invalidated every remembered approval) and able to
 * collapse to "[native code]" for proxied functions. Behaviour only changes
 * when someone changes the code, so an explicit version — bumped in review —
 * is both stable and auditable.
 *
 * Deliberately NOT bumped for the mutation-leaf scheme below: the remembered
 * approval BINDING carries its own `version` (1 = inode-bound leaf for
 * read/list_dir, 2 = canonical-path+type leaf for write/edit), so migrating
 * the mutation scheme invalidates exactly the rules whose evidence changed
 * while unchanged read/list_dir rules stay reusable.
 */
export const FS_TOOLS_IMPLEMENTATION = "fs-tools-v1"

type ChainEntry = { path: string; dev: string; ino: string; type: string }
/** Mutation leaf evidence: no dev/ino, because the approved operation itself
 *  replaces them (see the binding comment below). */
type LeafEntry = { path: string; type: string }

/** Permission evidence names the real workspace and every target ancestor.
 *  No traversal, symlinks/junctions, special files or missing parent chains.
 *
 *  Two binding schemes, chosen by operation:
 *
 *  - v1 (`read`, `list_dir`): every chain element, leaf included, is bound by
 *    dev+ino+type. Nothing this package does recreates a read or listing
 *    target, so an external replacement must invalidate the remembered rule;
 *    the leaf inode is the right identity there.
 *
 *  - v2 (`write`, `edit`): every ANCESTOR stays bound exactly as in v1, so
 *    swapping a directory for a symlink/junction or replacing it with another
 *    directory after approval still invalidates the rule. The LEAF is bound by
 *    its canonical resolved path + type only, never by dev+ino. Both tools
 *    write through `writeFileAtomic`, so every successful write replaces the
 *    leaf inode — a dev+ino leaf binding was invalidated by the very operation
 *    it authorized (a workspace remembered approval could be granted but never
 *    reused, and a second identical prepare waited for approval forever).
 *    The leaf inode carries no authority for a mutation: the operation renames
 *    a temp file onto the canonical path, so the path (and what is currently
 *    there) is what it can affect. The remaining leaf guarantees are unchanged:
 *    - a symlink anywhere in the chain, leaf included, has no identity;
 *    - a hard-linked leaf (nlink > 1) or inode 0 has no identity;
 *    - a non-regular / non-directory leaf has no identity;
 *    - the leaf TYPE is still part of the evidence, so a leaf removed or
 *      changed to another kind no longer matches (a write approved for a
 *      missing leaf is not silently reused once a file appears there; that
 *      next identical call takes one fresh approval, after which the typed
 *      evidence is reusable);
 *    - a regular file REPLACED BY another regular file at the same canonical
 *      path reuses the rule. That is the intended trade-off: the approved
 *      complete arguments (hashed as `argsDigest`) pin exactly what will be
 *      written, and no inode-level binding can distinguish the tool's own
 *      atomic replacement from a third party's.
 */
export function filesystemApprovalIdentity(workspace: string, path: string, operation: "read" | "write" | "edit" | "list_dir", implementation: string): PreparedToolIdentity | undefined {
  try {
    if (!path || path.length > 4096 || path.split(/[\\/]/).includes("..") || path.replace(/^[A-Za-z]:/, "").includes(":")) return undefined
    const root = resolve(workspace); const target = resolve(root, path)
    const rel = relative(root, target)
    if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) return undefined
    // The workspace root itself must be its own real path: everything below is
    // then judged relative to a canonical root, and the leaf path recorded for
    // a mutation is canonical because every component was proven not a link.
    if (relative(realpathSync(root), root) !== "") return undefined
    const segments = target.slice(parse(target).root.length).split(/[\\/]/).filter(Boolean)
    if (segments.length > 64) return undefined
    // `write` and `edit` both mutate the leaf through `writeFileAtomic`
    // (same-directory temp file + rename), so they replace its inode by design.
    const mutate = operation === "write" || operation === "edit"
    let current = parse(target).root
    const chain: (ChainEntry | LeafEntry)[] = []
    for (let index = 0; index < segments.length; index++) {
      current = join(current, segments[index]!)
      let stat
      try { stat = lstatSync(current, { bigint: true }) }
      catch (error) {
        // Only `write` may target a missing leaf, and only its mutation leaf
        // (path+type) shape is produced here: no inode exists to name.
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && index === segments.length - 1 && operation === "write") { chain.push({ path: current, type: "missing" }); break }
        return undefined
      }
      if (stat.isSymbolicLink() || !(stat.isDirectory() || stat.isFile())) return undefined
      if (stat.isFile() && (stat.nlink > 1n || stat.ino === 0n)) return undefined
      if (index < segments.length - 1 && !stat.isDirectory()) return undefined
      if (index === segments.length - 1 && (operation === "list_dir" ? !stat.isDirectory() : !stat.isFile())) return undefined
      const type = stat.isDirectory() ? "directory" : "file"
      // Leaf of an atomic mutation: canonical path + type only. Every
      // ancestor (and the leaf of read/list_dir) keeps the v1 dev+ino entry.
      if (mutate && index === segments.length - 1) chain.push({ path: current, type })
      else chain.push({ path: current, dev: String(stat.dev), ino: String(stat.ino), type })
    }
    if (!chain.length) return undefined
    const version = mutate ? 2 : 1
    return { binding: JSON.stringify({ version, operation, root, target, chain, implementation: createHash("sha256").update(implementation).digest("hex") }), executablePaths: [process.execPath] }
  } catch { return undefined }
}
