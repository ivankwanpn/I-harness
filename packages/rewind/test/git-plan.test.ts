// M58 R-B4 A integration: plan().unseen against a REAL temp git repository.
// The journal records what the agent did; git reveals what it did not — and
// the service filters the two so an agent's own uncommitted work is never
// misreported as "unseen".
import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createGitProbe, RewindService, RewindStore, sha256Hex } from "../src/index.ts"

const utf8 = (s: string) => new TextEncoder().encode(s)
const H = (s: string) => sha256Hex(utf8(s))

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], {
    cwd,
    stdio: "ignore",
  })
}

function record(path: string, opts: { preBlob?: string; isNewFile?: boolean; afterHash?: string } = {}) {
  return {
    path,
    status: "modified" as const,
    ...(opts.preBlob !== undefined ? { preBlob: opts.preBlob } : {}),
    ...(opts.isNewFile !== undefined ? { isNewFile: opts.isNewFile } : {}),
    ...(opts.afterHash !== undefined ? { afterHash: opts.afterHash } : {}),
  }
}

describe("plan().unseen (R-B4 A, real git repo)", () => {
  let root: string
  let workspace: string
  let store: RewindStore
  let service: RewindService

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "i-harness-gitplan-"))
    workspace = join(root, "ws")
    mkdirSync(workspace)
    git(workspace, "init", "-q")
    // Committed baseline files.
    writeFileSync(join(workspace, "committed.txt"), "v1")
    writeFileSync(join(workspace, "del.txt"), "d")
    writeFileSync(join(workspace, "gone2.txt"), "g")
    git(workspace, "add", "-A")
    git(workspace, "commit", "-q", "-m", "base")

    store = new RewindStore({ root, sessionId: "s" })
    service = new RewindService({
      store,
      workspace,
      gitProbe: createGitProbe({ workspace }),
    })

    // Journal: turn 0 records agent.txt (unchanged since) + gone2.txt (deleted);
    // turn 1 is the TARGET; turn 2 records later.txt (→ unTracked).
    writeFileSync(join(workspace, "agent.txt"), "agent-v1")
    writeFileSync(join(workspace, "target.txt"), "t")
    writeFileSync(join(workspace, "later.txt"), "l")
    await store.appendPoint({
      turnIndex: 0,
      anchorSeq: 0,
      promptPreview: "t0",
      files: [record("agent.txt", { afterHash: H("agent-v1") }), record("gone2.txt")],
    })
    await store.appendPoint({
      turnIndex: 1,
      anchorSeq: 10,
      promptPreview: "t1",
      files: [record("target.txt", { afterHash: H("t") })],
    })
    await store.appendPoint({
      turnIndex: 2,
      anchorSeq: 20,
      promptPreview: "t2",
      files: [record("later.txt", { afterHash: H("l") })],
    })
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it("lists shell/external changes the journal cannot explain, and nothing else", async () => {
    // shell-modified committed file; shell-created untracked file; shell-deleted
    // committed file. gone2.txt is a RECORDED deletion still absent (explained).
    writeFileSync(join(workspace, "committed.txt"), "v2")
    writeFileSync(join(workspace, "shell.txt"), "s")
    unlinkSync(join(workspace, "gone2.txt"))
    unlinkSync(join(workspace, "del.txt"))

    const plan = await service.plan(1)
    expect(plan.unseen).toEqual([
      { path: "committed.txt", kind: "modified" },
      { path: "del.txt", kind: "deleted" },
      { path: "shell.txt", kind: "untracked" },
    ])
    // never a file op
    expect(plan.ops.every((op) => !plan.unseen!.some((u) => u.path === op.path))).toBe(true)
  })

  it("does not misreport the agent's own uncommitted recorded work", async () => {
    // agent.txt is git-dirty (untracked) but its content equals the recorded
    // afterHash — the recorder's own work, unchanged since. later.txt is a
    // later recorded turn (→ unTracked) and target.txt is the target set.
    const plan = await service.plan(1)
    expect(plan.unseen).toBeUndefined()
    expect(plan.unTracked).toContain("later.txt")
  })

  it("lists a recorded path whose content changed after the recorder last saw it", async () => {
    writeFileSync(join(workspace, "agent.txt"), "agent-v2")
    const plan = await service.plan(1)
    expect(plan.unseen).toEqual([{ path: "agent.txt", kind: "untracked" }])
  })

  it("lists a recorded-deleted path that reappeared on disk", async () => {
    writeFileSync(join(workspace, "gone2.txt"), "back")
    const plan = await service.plan(1)
    expect(plan.unseen).toEqual([{ path: "gone2.txt", kind: "modified" }])
  })

  it("is absent when the workspace is not a git work tree", async () => {
    const plain = join(root, "plain")
    mkdirSync(plain)
    const plainStore = new RewindStore({ root: join(root, "other"), sessionId: "p" })
    await plainStore.appendPoint({ turnIndex: 0, anchorSeq: 0, promptPreview: "p", files: [] })
    const plainService = new RewindService({
      store: plainStore,
      workspace: plain,
      gitProbe: createGitProbe({ workspace: plain }),
    })
    const plan = await plainService.plan(0)
    expect(plan.unseen).toBeUndefined()
  })

  it("is absent when no probe is injected (pre-M58 behavior)", async () => {
    writeFileSync(join(workspace, "shell.txt"), "s")
    const bare = new RewindService({ store, workspace })
    const plan = await bare.plan(1)
    expect(plan.unseen).toBeUndefined()
  })
})
