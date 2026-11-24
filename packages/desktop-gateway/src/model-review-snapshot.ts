import { createHash } from "node:crypto"
import type { ModelReviewFile, ModelReviewLayer, ModelReviewSnapshot, ModelReviewTarget } from "./model-review-contract.ts"

const maxEntries = 64
const maxListingBytes = 64 * 1024
const maxFileBytes = 12 * 1024
const maxPatchBytes = 56 * 1024
const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

export function readModelReviewTarget(raw: unknown): ModelReviewTarget {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Choose a review target")
  const target = raw as Record<string, unknown>
  if (target.kind === "working") return { kind: target.kind }
  if (target.kind === "base" && typeof target.branch === "string"
    && /^[^\u0000-\u0020\u007f~-][^\u0000-\u0020\u007f~^:?*\[\\@]{0,254}$/u.test(target.branch)) {
    return { kind: target.kind, branch: target.branch }
  }
  if (target.kind === "commit" && typeof target.sha === "string" && /^[0-9a-f]{7,64}$/i.test(target.sha)) {
    return { kind: target.kind, sha: target.sha.toLowerCase() }
  }
  throw new Error("Choose working changes, a branch name or a commit SHA")
}

interface Source {
  git(args: string[], limit: number): Promise<{ data: Buffer; code: number | null; truncated: boolean; missing: boolean }>
  untracked(path: string, maxBytes: number): Promise<{ text?: string; truncated?: boolean; binary?: boolean }>
}

export function snapshotText(bytes: Buffer, truncated: boolean): string | undefined {
  if (bytes.includes(0)) return undefined
  for (let trim = 0; trim <= (truncated ? Math.min(3, bytes.length) : 0); trim++) {
    try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, bytes.length - trim)) }
    catch { /* The size limit can cut the final UTF-8 character. */ }
  }
}

export function reviewSnapshotReader(source: Source) {
  async function resolveCommit(ref: string): Promise<string | undefined> {
    const result = await source.git(["--no-replace-objects", "rev-parse", "--verify", "--end-of-options", ref + "^{commit}"], 100)
    const value = result.data.toString("utf8").trim()
    if (result.missing) throw new Error("Git is unavailable")
    return result.code === 0 && !result.truncated && oid.test(value) ? value : undefined
  }

  async function command(args: string[], limit: number) {
    const result = await source.git(args, limit)
    if (result.missing) throw new Error("Git is unavailable")
    if (result.code !== 0 && !result.truncated) throw new Error("Could not read the Git review scope")
    return result
  }

  async function capture(target: ModelReviewTarget): Promise<ModelReviewSnapshot> {
    const head = await resolveCommit("HEAD")
    if (!head) throw new Error("The selected workspace has no committed HEAD")
    let base = head
    let end: string | undefined
    const working = target.kind === "working"
    let rootCommit = false
    if (target.kind === "base") {
      const branch = target.branch
      const branchOid = await resolveCommit("refs/heads/" + branch) ?? await resolveCommit("refs/remotes/" + branch)
      if (!branchOid) throw new Error("The base branch is unavailable")
      const common = await command(["--no-replace-objects", "merge-base", branchOid, head], 100)
      base = common.data.toString("utf8").trim()
      if (!oid.test(base) || common.truncated) throw new Error("The selected commits have no available merge base")
      end = head
    } else if (target.kind === "commit") {
      end = await resolveCommit(target.sha)
      if (!end) throw new Error("The commit does not exist or is ambiguous")
      // Read the commit header itself. A shallow rev-list can report no
      // parents even when the commit is not the first commit of the repo.
      const commit = await command(["--no-replace-objects", "cat-file", "commit", end], 64 * 1024)
      const text = commit.data.toString("utf8")
      const headerEnd = text.indexOf("\n\n")
      if (!text.startsWith("tree ") || headerEnd < 0) throw new Error("The commit header is unavailable")
      const parent = text.slice(0, headerEnd).split("\n").find(line => line.startsWith("parent "))?.slice(7)
      if (parent && (!oid.test(parent) || !await resolveCommit(parent))) throw new Error("The commit's first parent is unavailable")
      rootCommit = !parent
      base = parent ?? ""
    }

    const common = ["--no-renames", "--relative", "--no-ext-diff", "--no-textconv", "--no-color", "--ignore-submodules=all"]
    const committed = rootCommit
      ? ["--no-replace-objects", "--literal-pathspecs", "diff-tree", "--root", "--no-commit-id", "-r", ...common, end!]
      : ["--no-replace-objects", "--literal-pathspecs", "diff", ...common, base, end!]
    const commands = working
      ? [
        { layer: "staged" as const, args: ["--no-replace-objects", "--literal-pathspecs", "diff", ...common, "--cached", head] },
        { layer: "unstaged" as const, args: ["--no-replace-objects", "--literal-pathspecs", "diff", ...common] },
        { layer: "untracked" as const, args: ["--literal-pathspecs", "ls-files", "--others", "--exclude-standard"] },
      ]
      : [{ layer: "committed" as const, args: committed }]
    const files: ModelReviewFile[] = []
    let listingTruncated = false
    let remaining = maxPatchBytes
    for (const { layer, args } of commands) {
      const list = await command([...args, ...(layer === "untracked" ? [] : ["--name-only"]), "-z", "--", "."], maxListingBytes)
      const listed = list.data.toString("utf8").split("\0")
      listed.pop() // Only NUL-terminated paths are complete, including when clipped.
      const paths = Array.from(new Set(listed)).filter(Boolean)
      listingTruncated ||= list.truncated || paths.length > maxEntries - files.length
      for (const path of paths.slice(0, maxEntries - files.length)) {
        const file: ModelReviewFile = { path, layer: layer as ModelReviewLayer, disposition: "omitted" }
        files.push(file)
        if (!remaining) continue
        // Ambiguous path encoding and repository link contents are excluded.
        if (path.includes("\ufffd") || /[\u0000-\u001f\u007f]/u.test(path)) { file.disposition = "unavailable"; continue }
        const limit = Math.min(remaining, maxFileBytes)
        if (layer === "untracked") {
          const value = await source.untracked(path, limit)
          file.disposition = value.text === undefined ? (value.binary ? "binary" : "unavailable") : "text"
          if (value.text !== undefined) Object.assign(file, { text: value.text, truncated: value.truncated })
        } else {
          const patch = await command([...args, "--patch", "--unified=3", "--", path], limit)
          const value = snapshotText(patch.data.subarray(0, limit), patch.truncated)
          const binary = value === undefined || /^Binary files .+ differ$/m.test(value)
          file.disposition = binary ? "binary" : value === "" ? "unavailable" : "text"
          if (file.disposition === "text") Object.assign(file, { text: value, truncated: patch.truncated })
        }
        remaining -= Buffer.byteLength(file.text ?? "", "utf8")
      }
    }
    const metadata = { target, head, base, ...(end === undefined ? {} : { end }), files, listingTruncated }
    return { ...metadata, capturedAt: new Date().toISOString(), fingerprint: createHash("sha256").update(JSON.stringify(metadata)).digest("hex") }
  }

  return async (target: ModelReviewTarget): Promise<ModelReviewSnapshot> => {
    const snapshot = await capture(target)
    // Working changes consist of independent observations of the index and
    // worktree. Admit only a verified capture, then use the staged bytes.
    if (target.kind === "working" && (await capture(target)).fingerprint !== snapshot.fingerprint) {
      throw new Error("The working changes moved during capture. Prepare the review again")
    }
    return snapshot
  }
}
