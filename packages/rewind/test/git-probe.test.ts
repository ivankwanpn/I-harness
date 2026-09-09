// M58 R-B4 A: the git probe — read-only workspace observation for plan().
// Unit tests with an INJECTED exec (no real git): command shape, porcelain -z
// parsing, toplevel → workspace mapping, exclusion, and the fail-soft edges.
import { describe, expect, it } from "vitest"
import { createGitProbe, createGitProbeForStore, type GitExec, type GitExecOptions } from "../src/git-probe.ts"

/** Fake exec: records calls, answers by command kind. */
function fakeExec(answers: {
  revParse?: { stdout: string } | Error
  status?: { stdout: string } | Error
}): { exec: GitExec; calls: Array<{ args: string[]; opts: GitExecOptions }> } {
  const calls: Array<{ args: string[]; opts: GitExecOptions }> = []
  const exec: GitExec = async (file, args, opts) => {
    calls.push({ args, opts })
    if (args[0] === "rev-parse") {
      if (answers.revParse instanceof Error) throw answers.revParse
      return answers.revParse ?? { stdout: "true\n/ws\n" }
    }
    if (args[0] === "status") {
      if (answers.status instanceof Error) throw answers.status
      return answers.status ?? { stdout: "" }
    }
    throw new Error(`unexpected git invocation: ${file} ${args.join(" ")}`)
  }
  return { exec, calls }
}

const z = (...entries: string[]): string => entries.map((e) => `${e}\0`).join("")

describe("createGitProbe", () => {
  it("returns [] when the workspace is not inside a git work tree", async () => {
    const { exec } = fakeExec({ revParse: { stdout: "false\n/ws\n" } })
    const probe = createGitProbe({ workspace: "/ws", exec })
    expect(await probe.changes()).toEqual([])
  })

  it("returns [] when git is unavailable (rev-parse throws)", async () => {
    const { exec } = fakeExec({ revParse: new Error("git not found") })
    const probe = createGitProbe({ workspace: "/ws", exec })
    expect(await probe.changes()).toEqual([])
  })

  it("returns [] when status throws (fail-soft)", async () => {
    const { exec } = fakeExec({ status: new Error("boom") })
    const probe = createGitProbe({ workspace: "/ws", exec })
    expect(await probe.changes()).toEqual([])
  })

  it("parses porcelain -z entries into workspace-relative changes", async () => {
    const { exec } = fakeExec({
      status: {
        stdout: z(" M src/a.ts", "?? new.txt", " D gone.txt", "A  staged.txt"),
      },
    })
    const probe = createGitProbe({ workspace: "/ws", exec })
    expect(await probe.changes()).toEqual([
      { path: "src/a.ts", kind: "modified" },
      { path: "new.txt", kind: "untracked" },
      { path: "gone.txt", kind: "deleted" },
      { path: "staged.txt", kind: "modified" },
    ])
  })

  it("a rename entry reports the new path (modified) AND the old path (deleted)", async () => {
    const { exec } = fakeExec({ status: { stdout: z("R  b.txt", "a.txt") } })
    const probe = createGitProbe({ workspace: "/ws", exec })
    expect(await probe.changes()).toEqual([
      { path: "b.txt", kind: "modified" },
      { path: "a.txt", kind: "deleted" },
    ])
  })

  it("maps toplevel-relative paths into the workspace and drops paths outside it", async () => {
    const { exec } = fakeExec({
      revParse: { stdout: "true\n/repo\n" },
      status: { stdout: z(" M sub/in.txt", " M other/out.txt") },
    })
    const probe = createGitProbe({ workspace: "/repo/sub", exec })
    expect(await probe.changes()).toEqual([{ path: "in.txt", kind: "modified" }])
  })

  it("drops paths under an excluded prefix (the rewind store lives in the workspace)", async () => {
    const { exec } = fakeExec({
      status: { stdout: z("?? .sessions/rewind/s/points.jsonl", "?? keep.txt") },
    })
    const probe = createGitProbe({
      workspace: "/ws",
      excludePrefixes: [".sessions"],
      exec,
    })
    expect(await probe.changes()).toEqual([{ path: "keep.txt", kind: "untracked" }])
  })

  it("runs read-only git with no optional locks and a bounded timeout", async () => {
    const { exec, calls } = fakeExec({})
    const probe = createGitProbe({ workspace: "/ws", exec, timeoutMs: 1234 })
    await probe.changes()
    expect(calls.map((c) => c.args)).toEqual([
      ["rev-parse", "--is-inside-work-tree", "--show-toplevel"],
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    ])
    for (const c of calls) {
      expect(c.opts.cwd).toBe("/ws")
      expect(c.opts.timeout).toBe(1234)
      expect(c.opts.env.GIT_TERMINAL_PROMPT).toBe("0")
      expect(c.opts.env.GIT_OPTIONAL_LOCKS).toBe("0")
    }
  })

  it("memoizes the probe result (one git pass per probe instance)", async () => {
    const { exec, calls } = fakeExec({ status: { stdout: z(" M a.txt") } })
    const probe = createGitProbe({ workspace: "/ws", exec })
    await probe.changes()
    await probe.changes()
    expect(calls.filter((c) => c.args[0] === "status")).toHaveLength(1)
  })
})

describe("createGitProbeForStore", () => {
  const storeIn = (pointsFile: string) => ({ pointsFile })

  it("excludes the store's rewind dir when it lives inside the workspace", async () => {
    const { exec } = fakeExec({
      status: { stdout: z("?? .sessions/rewind/s/points.jsonl", "?? keep.txt") },
    })
    const probe = createGitProbeForStore(
      storeIn("/ws/.sessions/rewind/s/points.jsonl"),
      "/ws",
      { exec },
    )
    expect(await probe.changes()).toEqual([{ path: "keep.txt", kind: "untracked" }])
  })

  it("adds no exclusion when the store lives outside the workspace", async () => {
    const { exec, calls } = fakeExec({
      status: { stdout: z("?? keep.txt") },
    })
    const probe = createGitProbeForStore(storeIn("/other/rewind/s/points.jsonl"), "/ws", { exec })
    expect(await probe.changes()).toEqual([{ path: "keep.txt", kind: "untracked" }])
    expect(calls).toHaveLength(2) // rev-parse + status, no extra git
  })
})
