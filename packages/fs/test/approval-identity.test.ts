import { linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, beforeEach, expect, it } from "vitest"
import { createContext } from "../../core-plugin/src/index.ts"
import { createToolRegistry } from "@i-harness/core-tools"
import { FS_TOOLS_IMPLEMENTATION, filesystemApprovalIdentity } from "../src/approval-identity.ts"
import { writeFileAtomic } from "../src/atomic.ts"
import { createFsTools } from "../src/index.ts"

/**
 * Contract for the remembered-approval identity of filesystem operations.
 *
 * The historic binding hashed every chain element by dev+ino. `write`/`edit`
 * perform an atomic replacement (same-directory temp + rename, `src/atomic.ts`),
 * so a successful mutation changed the leaf inode and invalidated the very
 * approval that had authorized it: the next identical prepare could never match
 * a remembered workspace rule and waited for a human forever. For mutation
 * operations the leaf is now bound by canonical path + type only, while every
 * ancestor stays dev+ino bound and every non-regular/hard-linked/symlinked leaf
 * remains unrepresentable. Reads/listings keep the inode-bound leaf: nothing in
 * this package recreates their target, so replacement must still revoke.
 */

/** Identity as the shipped tools compute it (shared implementation token). */
const identity = (workspace: string, path: string, operation: "read" | "write" | "edit" | "list_dir") =>
  filesystemApprovalIdentity(workspace, path, operation, FS_TOOLS_IMPLEMENTATION)

const bindingOf = (value: { binding: string } | undefined) => {
  if (!value) throw new Error("expected a binding identity")
  return JSON.parse(value.binding) as {
    version: number
    operation: string
    root: string
    target: string
    chain: { path: string; dev?: string; ino?: string; type: string }[]
  }
}

const inodeOf = (path: string) => lstatSync(path, { bigint: true }).ino

let base: string
let workspace: string
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "ih-fs-identity-"))
  workspace = join(base, "ws")
  mkdirSync(workspace)
})
afterEach(() => { rmSync(base, { recursive: true, force: true }) })

it("binds the mutation leaf by canonical path + type so the atomic write it authorizes keeps the binding stable", async () => {
  const target = join(workspace, "notes.txt")
  writeFileSync(target, "old")
  const args = { path: "notes.txt", text: "new" }
  const before = identity(workspace, "notes.txt", "write")
  const parsed = bindingOf(before)
  // Mutation scheme: version 2, ancestors keep inode identity, leaf is path+type.
  expect(parsed.version).toBe(2)
  expect(parsed.operation).toBe("write")
  expect(parsed.target).toBe(target)
  expect(parsed.chain.length).toBeGreaterThan(1)
  const leaf = parsed.chain.at(-1)!
  expect(leaf).toEqual({ path: target, type: "file" })
  for (const ancestor of parsed.chain.slice(0, -1)) {
    expect(ancestor.type).toBe("directory")
    expect(ancestor.dev).toMatch(/^\d+$/)
    expect(ancestor.ino).toMatch(/^\d+$/)
  }

  const registry = createToolRegistry(createContext())
  const write = createFsTools({ workspace }).find((tool) => tool.name === "write")!
  registry.register(write)
  const inoBefore = inodeOf(target)
  await registry.dispatch(await registry.prepare({ name: "write", args }))
  expect(readFileSync(target, "utf8")).toBe("new")
  // The operation really did replace the leaf inode (the old failure mode).
  expect(inodeOf(target)).not.toBe(inoBefore)

  // Re-evaluation after the atomic write — including from a fresh tool
  // instance, i.e. the restart-like path used by remembered approvals — is
  // byte-identical, so the rule remains reusable.
  expect(identity(workspace, "notes.txt", "write")!.binding).toBe(before!.binding)
  const restarted = createFsTools({ workspace }).find((tool) => tool.name === "write")!
  expect(restarted.approvalIdentity!(args)!.binding).toBe(before!.binding)
})

it("keeps an approved edit reusable across its own atomic write, and keeps write/edit bindings distinct", async () => {
  const target = join(workspace, "notes.txt")
  writeFileSync(target, "old")
  const before = identity(workspace, "notes.txt", "edit")!
  expect(bindingOf(before).version).toBe(2)
  expect(bindingOf(before).chain.at(-1)).toEqual({ path: target, type: "file" })
  const registry = createToolRegistry(createContext())
  const edit = createFsTools({ workspace }).find((tool) => tool.name === "edit")!
  registry.register(edit)
  const inoBefore = inodeOf(target)
  await registry.dispatch(await registry.prepare({ name: "edit", args: { path: "notes.txt", old_string: "old", new_string: "new" } }))
  expect(readFileSync(target, "utf8")).toBe("new")
  expect(inodeOf(target)).not.toBe(inoBefore)
  expect(identity(workspace, "notes.txt", "edit")!.binding).toBe(before.binding)
  // The operation itself is part of the evidence: a write approval cannot be
  // replayed as an edit approval (or vice versa).
  expect(identity(workspace, "notes.txt", "write")!.binding).not.toBe(before.binding)
})

it("keeps read and list_dir leaves inode-bound, so replacing a read target still revokes the rule", () => {
  const target = join(workspace, "notes.txt")
  writeFileSync(target, "old")
  const readBefore = identity(workspace, "notes.txt", "read")!
  const readParsed = bindingOf(readBefore)
  expect(readParsed.version).toBe(1)
  expect(readParsed.chain.at(-1)!.dev).toMatch(/^\d+$/)
  expect(readParsed.chain.at(-1)!.ino).toMatch(/^\d+$/)
  writeFileSync(target, "replaced externally") // same inode, content-only
  expect(identity(workspace, "notes.txt", "read")!.binding).toBe(readBefore.binding)
  const list = bindingOf(identity(workspace, ".", "list_dir"))
  expect(list.version).toBe(1)
  expect(list.chain.at(-1)!.type).toBe("directory")
  expect(list.chain.at(-1)!.ino).toMatch(/^\d+$/)
})

it("still refuses symlinked, hard-linked, non-regular, directory and missing targets for mutations", () => {
  const target = join(workspace, "notes.txt")
  writeFileSync(target, "old")
  const outside = join(base, "outside")
  mkdirSync(outside)
  writeFileSync(join(outside, "secret.txt"), "fixture")

  // Hard-linked leaf: both names have nlink 2, neither has an identity.
  const hardlink = join(workspace, "alias.txt")
  linkSync(target, hardlink)
  expect(lstatSync(target, { bigint: true }).nlink).toBe(2n)
  expect(identity(workspace, "notes.txt", "write")).toBeUndefined()
  expect(identity(workspace, "alias.txt", "write")).toBeUndefined()

  // Symlinked leaf (junction on win32, directory symlink elsewhere).
  const link = join(workspace, "link")
  symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir")
  expect(identity(workspace, "link", "write")).toBeUndefined()
  expect(identity(workspace, "link", "list_dir")).toBeUndefined()
  // Symlink traversal anywhere in the chain.
  expect(identity(workspace, "link/secret.txt", "write")).toBeUndefined()

  // Non-regular leaves: a directory cannot be mutated as a file.
  mkdirSync(join(workspace, "dir"))
  expect(identity(workspace, "dir", "write")).toBeUndefined()
  expect(identity(workspace, "dir", "edit")).toBeUndefined()
  // ...but list_dir on a directory is the approved operation.
  expect(bindingOf(identity(workspace, "dir", "list_dir")).chain.at(-1)!.type).toBe("directory")

  // Missing targets: write may create one, edit may not mutate one.
  expect(bindingOf(identity(workspace, "new.txt", "write")).chain.at(-1)).toEqual({ path: join(workspace, "new.txt"), type: "missing" })
  expect(identity(workspace, "absent.txt", "edit")).toBeUndefined()
  // A missing parent chain has no identity even for write.
  expect(identity(workspace, join("missing", "parent", "file.txt"), "write")).toBeUndefined()

  // Escapes, traversal and alternate data stream syntax stay refused.
  expect(identity(workspace, "../outside.txt", "write")).toBeUndefined()
  expect(identity(workspace, join(base, "outside.txt"), "write")).toBeUndefined()
  expect(identity(workspace, "notes.txt:stream", "write")).toBeUndefined()
})

it("revokes on a leaf TYPE change and reuses across a same-type replacement at the canonical path", () => {
  const target = join(workspace, "notes.txt")
  writeFileSync(target, "old")
  const fileIdentity = identity(workspace, "notes.txt", "write")!
  const missingIdentity = identity(workspace, "made.txt", "write")!
  expect(bindingOf(missingIdentity).chain.at(-1)!.type).toBe("missing")

  // Type change: missing -> file is a different evidence record, so a write
  // approved against a missing leaf is not silently reused after a file
  // appears; one fresh approval is required, then it is reusable.
  writeFileSync(join(workspace, "made.txt"), "created")
  const created = identity(workspace, "made.txt", "write")!
  expect(created.binding).not.toBe(missingIdentity.binding)
  writeFileSync(join(workspace, "made.txt"), "created again") // same inode/type
  expect(identity(workspace, "made.txt", "write")!.binding).toBe(created.binding)
  // Type change: existing file -> missing also changes the evidence, and a
  // directory (non-regular) at the path has no identity at all.
  rmSync(target)
  expect(identity(workspace, "notes.txt", "write")!.binding).not.toBe(fileIdentity.binding)
  mkdirSync(target)
  expect(identity(workspace, "notes.txt", "write")).toBeUndefined()

  // Same-type replacement at the same canonical path: the mutation scheme is
  // path+type, so an external rename over the leaf still matches (this is the
  // documented trade-off; the complete argument digest pins the write).
  writeFileSync(join(workspace, "swap.txt"), "one")
  const beforeSwap = identity(workspace, "swap.txt", "write")!
  writeFileSync(join(workspace, "incoming.txt"), "two")
  renameSync(join(workspace, "incoming.txt"), join(workspace, "swap.txt"))
  expect(identity(workspace, "swap.txt", "write")!.binding).toBe(beforeSwap.binding)
})

it("matches the direct writeFileAtomic replacement path used by both mutation tools", async () => {
  const target = join(workspace, "notes.txt")
  writeFileSync(target, "old")
  const before = identity(workspace, "notes.txt", "edit")!
  const inoBefore = inodeOf(target)
  await writeFileAtomic(target, "atomic body")
  expect(readFileSync(target, "utf8")).toBe("atomic body")
  expect(inodeOf(target)).not.toBe(inoBefore)
  expect(identity(workspace, "notes.txt", "edit")!.binding).toBe(before.binding)
})
