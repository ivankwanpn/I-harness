import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, expect, it, vi } from "vitest"
import { createDesktopHost } from "../src/host.ts"
import { createWorkspaceReview } from "../src/review.ts"
import type { ModelReviewJob } from "../src/model-review-contract.ts"
import type { LLMRequest } from "@i-harness/llm-seam"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (!root.startsWith(join(tmpdir(), "ih-model-review-"))) throw new Error("Unexpected review fixture path")
    await rm(root, { recursive: true, force: true })
  }
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ih-model-review-"))
  roots.push(root)
  const workspace = join(root, "repo")
  await mkdir(workspace)
  const git = (...args: string[]) => execFileSync("git", args, { cwd: workspace, encoding: "utf8", windowsHide: true }).trim()
  git("init", "-q", "-b", "main")
  git("config", "user.name", "Fixture")
  git("config", "user.email", "fixture@example.test")
  const file = join(workspace, "example.txt")
  await writeFile(file, "first\n")
  git("add", "example.txt")
  git("commit", "-qm", "root")
  const first = git("rev-parse", "HEAD")
  return { root, workspace, git, file, first }
}

it("captures immutable branch and commit OIDs, including a root commit and a merge's first parent", async () => {
  const { workspace, git, file, first } = await fixture()
  const review = createWorkspaceReview(workspace)
  try {
    git("checkout", "-qb", "feature")
    await writeFile(file, "second\n")
    git("commit", "-qam", "feature")
    const tip = git("rev-parse", "HEAD")
    const branch = await review.capture({ kind: "base", branch: "main" })
    expect(branch).toMatchObject({ head: tip, base: first, end: tip })
    expect(branch.files).toEqual([expect.objectContaining({ path: "example.txt", layer: "committed", text: expect.stringContaining("+second") })])
    const root = await review.capture({ kind: "commit", sha: first })
    expect(root).toMatchObject({ base: "", end: first })
    expect(root.files[0]).toMatchObject({ path: "example.txt", text: expect.stringContaining("+first") })
    git("checkout", "main")
    git("merge", "--no-ff", "-m", "merge", "feature")
    const merge = await review.capture({ kind: "commit", sha: git("rev-parse", "HEAD") })
    expect(merge.base).toBe(first)
    expect(merge.files[0]?.text).toContain("+second")
  } finally { await review.close() }
}, 20000)

it("captures separate staged, unstaged and untracked excerpts, and represents binary and truncated excerpts", async () => {
  const { workspace, git, file } = await fixture()
  const review = createWorkspaceReview(workspace)
  try {
    await writeFile(file, "staged\n")
    git("add", "example.txt")
    await writeFile(file, "working\n")
    await writeFile(join(workspace, "a new file.txt"), "new file\n")
    await writeFile(join(workspace, "blob"), Buffer.from([0, 255, 0]))
    await writeFile(join(workspace, "large.txt"), "長".repeat(5000))
    const status = git("status", "--porcelain", "-z")
    const snapshot = await review.capture({ kind: "working" })
    expect(snapshot.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ layer: "staged", path: "example.txt", text: expect.stringContaining("+staged") }),
      expect.objectContaining({ layer: "unstaged", path: "example.txt", text: expect.stringContaining("+working") }),
      expect.objectContaining({ layer: "untracked", path: "a new file.txt", text: "new file\n" }),
      expect.objectContaining({ layer: "untracked", path: "blob", disposition: "binary" }),
      expect.objectContaining({ layer: "untracked", path: "large.txt", truncated: true }),
    ]))
    expect(git("status", "--porcelain", "-z")).toBe(status)
    await writeFile(file, "replacement\n")
    expect((await review.capture({ kind: "working" })).fingerprint).not.toBe(snapshot.fingerprint)
    expect(snapshot.files.find(row => row.layer === "unstaged")?.text).toContain("+working")
  } finally { await review.close() }
}, 20000)

it("limits a nested workspace's review to paths in that workspace", async () => {
  const { workspace, git, file } = await fixture()
  const nested = join(workspace, "child")
  await mkdir(nested)
  const nestedFile = join(nested, "a named file.txt")
  await writeFile(nestedFile, "original\n")
  git("add", "child")
  git("commit", "-qm", "nested file")
  await writeFile(nestedFile, "in scope\n")
  await writeFile(file, "outside\n")
  const review = createWorkspaceReview(nested)
  try {
    const snapshot = await review.capture({ kind: "working" })
    expect(snapshot.files).toEqual([expect.objectContaining({ path: "a named file.txt", text: expect.stringContaining("+in scope") })])
  } finally { await review.close() }
}, 12000)

it("reports an unavailable parent rather than reviewing the full tree at a shallow boundary", async () => {
  const { root, workspace, git, file } = await fixture()
  await writeFile(file, "second\n")
  git("commit", "-qam", "second")
  const shallow = join(root, "shallow")
  git("clone", "--quiet", "--depth=1", pathToFileURL(workspace).href, shallow)
  const review = createWorkspaceReview(shallow)
  try {
    await expect(review.capture({ kind: "commit", sha: git("rev-parse", "HEAD") })).rejects.toThrow("first parent is unavailable")
  } finally { await review.close() }
}, 12000)

it("runs the captured diff through Gateway's configured provider, accepts one start and reopens the exact result", async () => {
  const { root, workspace, file, git } = await fixture()
  const sessionDir = join(root, "sessions")
  const settingsPath = join(root, "settings.json")
  const credentialsPath = join(root, "credentials.json")
  await writeFile(settingsPath, JSON.stringify({
    llm: { providers: { fixture: { protocol: "openai-completions", baseURL: "http://127.0.0.1:1", apiKeyEnv: "IH_TEST", models: [{ id: "fixture", contextWindow: 131072 }] } },
      defaultModel: { provider: "fixture", model: "fixture" } },
  }))
  await writeFile(credentialsPath, JSON.stringify({ refs: { IH_TEST: "fixture" } }))
  await writeFile(file, "accidental behavior\n")
  const seen: LLMRequest[] = []
  let settle!: () => void
  const response = () => new Promise<void>(resolve => { settle = resolve })
  let nextResponse = response()
  const waiting = new Map<number, { result?: any; error?: { message?: string } }>()
  let serial = 0
  const open = () => createDesktopHost({
    workspace, sessionDir, settingsPath, credentialsPath,
    onWrite: frame => { if (("result" in frame || "error" in frame) && typeof frame.id === "number") waiting.set(frame.id, frame) },
    buildProviderClient: () => ({
      async *stream(request) {
        seen.push(request)
        request.signal?.throwIfAborted()
        await Promise.race([nextResponse, new Promise<void>(resolve => request.signal?.addEventListener("abort", () => resolve(), { once: true }))])
        request.signal?.throwIfAborted()
        yield { type: "text/chunk", text: JSON.stringify({ summary: "Checked one change", findings: [{ title: "Unexpected behavior", detail: "The snapshot shows accidental behavior.", file: 0, line: 1 }] }) }
        yield { type: "end" }
      },
    }),
  })
  let host = await open()
  const call = async (method: string, params: unknown = {}) => {
    const id = ++serial
    await host.handleLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
    const frame = waiting.get(id)
    if (!frame || frame.error) throw new Error(frame?.error?.message ?? "No RPC reply")
    return frame.result
  }
  try {
    await call("initialize")
    const prepared: ModelReviewJob = await call("desktop/model-review/prepare", { target: { kind: "working" } })
    expect(prepared.status).toBe("prepared")
    expect(seen).toHaveLength(0)
    await writeFile(file, "newer content\n")
    git("commit", "-qam", "new HEAD after the review capture")
    const [first, retry] = await Promise.all([
      call("desktop/model-review/start", { id: prepared.id }),
      call("desktop/model-review/start", { id: prepared.id }),
    ])
    expect(first.id).toBe(retry.id)
    await vi.waitFor(() => expect(seen).toHaveLength(1), { timeout: 4000 })
    expect(seen[0]?.tools).toEqual([])
    expect(seen[0]?.messages[0]?.content).toContain("accidental behavior")
    expect(seen[0]?.messages[0]?.content).not.toContain("newer content")
    settle()
    await vi.waitFor(async () => expect((await call("desktop/model-review/read", { id: prepared.id })).status).toBe("completed"))
    expect(await call("desktop/model-review/compare", { id: prepared.id })).toEqual({ current: false })
    await host.close()
    host = await open()
    await call("initialize")
    const records = await call("desktop/model-review/list") as ModelReviewJob[]
    expect(records).toMatchObject([{ id: prepared.id, status: "completed" }])
    const reopened = await call("desktop/model-review/read", { id: prepared.id })
    expect(reopened.snapshot.fingerprint).toBe(prepared.snapshot.fingerprint)
    expect(reopened.result.findings[0]).toMatchObject({ file: 0, line: 1 })
    expect(await readFile(file, "utf8")).toBe("newer content\n")
    await writeFile(file, "another working change\n")
    nextResponse = response()
    const second: ModelReviewJob = await call("desktop/model-review/prepare", { target: { kind: "working" } })
    await call("desktop/model-review/start", { id: second.id })
    await vi.waitFor(() => expect(seen).toHaveLength(2), { timeout: 4000 })
    const cancelled = await call("desktop/model-review/cancel", { id: second.id })
    expect(cancelled.status).toBe("cancelled")
    expect(seen[1]?.signal?.aborted).toBe(true)
    expect((await call("desktop/model-review/read", { id: second.id })).result).toBeUndefined()
  } finally { settle(); await host.close() }
}, 30000)
