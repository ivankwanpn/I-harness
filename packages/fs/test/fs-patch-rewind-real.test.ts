import { afterEach, beforeEach, expect, it } from "vitest"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { existsSync } from "node:fs"
import { createFsTools, type FsToolDeps } from "../src/index.ts"
import { RewindRecorder, RewindStore, RewindService, sha256Hex } from "../../rewind/src/index.ts"
import { checkWrite } from "../../sandbox-policy/src/index.ts"

type Operation = "add" | "update" | "delete"
interface PatchResult { ok: boolean; applied: { path: string; action: string; preImageRef?: string; isNewFile?: boolean }[]; errors: { message: string }[] }
let root: string, workspace: string, outside: string, store: RewindStore, recorder: RewindRecorder
const before = "original\n", after = "replacement\n"
const hash = (text: string) => sha256Hex(new TextEncoder().encode(text))
const content = (operation: Operation, path: string) => `*** Begin Patch\n*** ${operation === "add" ? "Add" : operation === "update" ? "Update" : "Delete"} File: ${path}\n${operation === "add" ? "+replacement\n" : operation === "update" ? "@@\n-original\n+replacement\n" : ""}*** End Patch\n`
function policyFor(roots: string[]): Partial<FsToolDeps> {
  const policy = { mode: "workspace-write" as const, workspaceRoot: workspace, workspaceRoots: roots }
  return { sandboxPolicy: () => policy, writeGuard: (target, mode) => {
    const result = checkWrite({ ...policy, mode: mode ?? policy.mode }, target)
    return result.ok ? result : { ok: false, denial: { code: "SANDBOX_DENIED", surface: "fs", mode: mode ?? policy.mode, reason: result.reason } }
  } }
}
const run = async (operation: Operation, path: string, extras: Partial<FsToolDeps> = {}) => {
  const tool = createFsTools({ workspace, rewind: recorder, ...policyFor([workspace]), ...extras }).find(tool => tool.name === "apply_patch")!
  return await tool.execute({ patch_content: content(operation, path) }, {}) as PatchResult
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "i-harness-patch-real-"))
  workspace = join(root, "workspace"); outside = join(root, "references")
  await mkdir(join(workspace, "nested"), { recursive: true }); await mkdir(outside)
  store = new RewindStore({ root: join(root, "journal"), sessionId: "owned", workspace })
  recorder = new RewindRecorder({ store, workspace })
})
afterEach(async () => {
  await recorder.flush()
  if (!root.startsWith(join(tmpdir(), "i-harness-patch-real-"))) throw new Error("Refusing cleanup outside the owned fixture")
  await rm(root, { recursive: true, force: true })
})

it.each<Operation>(["add", "update", "delete"])("records and really restores a workspace absolute %s with an active recorder", async operation => {
  const target = join(workspace, "nested", "參考 檔案.txt")
  if (operation !== "add") await writeFile(target, before)
  recorder.begin(4, "absolute patch")
  const result = await run(operation, target)
  expect(result.ok).toBe(true)
  expect(result.errors).toEqual([])
  expect(result.applied[0]).toMatchObject(operation === "add" ? { isNewFile: true } : { preImageRef: hash(before) })
  expect(existsSync(target)).toBe(operation !== "delete")
  const point = (await recorder.finalize())!
  expect(point.files).toEqual([expect.objectContaining({ path: "nested/參考 檔案.txt", status: operation === "add" ? "added" : operation === "delete" ? "deleted" : "modified" })])
  await store.appendPoint(point); await recorder.commit(point.anchorSeq)
  const resultOfRewind = await new RewindService({ store, workspace }).execute(0, "files", { appendEvent() {} })
  expect(resultOfRewind.errors).toEqual([])
  if (operation === "add") expect(existsSync(target)).toBe(false)
  else expect(await readFile(target, "utf8")).toBe(before)
})

it.each<Operation>(["add", "update", "delete"])("keeps an explicitly permitted outside absolute %s out of the workspace journal", async operation => {
  const target = join(outside, "outside.txt")
  if (operation !== "add") await writeFile(target, before)
  recorder.begin(4, "allowed secondary root")
  const result = await run(operation, target, policyFor([workspace, outside]))
  expect(result.ok).toBe(true)
  expect(result.applied[0]).not.toHaveProperty("preImageRef")
  expect(result.applied[0]).not.toHaveProperty("isNewFile")
  const point = (await recorder.finalize())!
  expect(point.files).toEqual([])
  await store.appendPoint(point); await recorder.commit(point.anchorSeq)
  await new RewindService({ store, workspace }).execute(0, "files", { appendEvent() {} })
  if (operation === "delete") expect(existsSync(target)).toBe(false)
  else expect(await readFile(target, "utf8")).toBe(after)
})

it.each<Operation>(["add", "update", "delete"])("refuses a readonly reference absolute %s before either writing or capturing", async operation => {
  const target = join(outside, "reference.txt")
  if (operation !== "add") await writeFile(target, before)
  recorder.begin(4, "readonly reference")
  const result = await run(operation, target)
  expect(result.ok).toBe(false)
  expect(result.applied).toEqual([])
  expect(result.errors[0]!.message).toContain("outside the session workspace roots")
  expect((await recorder.finalize())!.files).toEqual([])
  if (operation === "add") expect(existsSync(target)).toBe(false)
  else expect(await readFile(target, "utf8")).toBe(before)
})

it("retains one original preimage when relative and absolute updates address the same file", async () => {
  const target = join(workspace, "nested", "alias.txt")
  await writeFile(target, before); recorder.begin(4, "aliases")
  const first = await run("update", "./nested/alias.txt")
  expect(first.ok).toBe(true)
  const tool = createFsTools({ workspace, rewind: recorder }).find(tool => tool.name === "apply_patch")!
  const second = await tool.execute({ patch_content: content("update", target).replace("-original", "-replacement").replace("+replacement", "+final") }, {}) as PatchResult
  expect(second.ok).toBe(true)
  expect(second.applied[0]!.preImageRef).toBe(first.applied[0]!.preImageRef)
  const point = (await recorder.finalize())!
  expect(point.files).toHaveLength(1)
  expect(point.files[0]).toMatchObject({ path: "nested/alias.txt", preBlob: hash(before) })
})

it("does not advertise a rewind capture for an absolute Add outside an active turn", async () => {
  const result = await run("add", join(workspace, "idle.txt"))
  expect(result.ok).toBe(true)
  expect(result.applied[0]).not.toHaveProperty("isNewFile")
  expect(await recorder.finalize()).toBeNull()
})
