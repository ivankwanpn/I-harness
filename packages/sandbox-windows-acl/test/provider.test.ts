import { describe, expect, it, vi } from "vitest"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { classifyRunnerFailure, SandboxUnavailableError } from "@i-harness/sandbox"
import { AclWriteGrant, createWindowsAclSandbox } from "../src/index.ts"
import type { SandboxPolicy } from "@i-harness/sandbox"

// Reproduced on this host (Windows 11 26200, Git Bash 5.3.15) with the REAL
// provider: a confined MSYS/Cygwin program cannot create the named signal pipe
// its runtime needs, so it dies inside DLL initialization before the command
// body runs. Verbatim stderr and exit code, captured through `spawnSync` on the
// provider's own argv.
const MSYS_SIGNAL_PIPE_FATAL =
  "      0 [main] bash (16664) C:\\Program Files\\Git\\bin\\..\\usr\\bin\\bash.exe: *** fatal error - couldn't create signal pipe, Win32 error 5"
/** STATUS_DLL_INIT_FAILED — what Node reports for that death (`status >>> 0`). */
const DLL_INIT_FAILED = 3221225794

const readOnly: SandboxPolicy = { mode: "read-only", workspaceRoot: process.cwd() }

describe("createWindowsAclSandbox", () => {
  it("returns a SandboxProvider (shape)", () => {
    const provider = createWindowsAclSandbox({ writableDirs: [process.cwd()], mode: "read-only" })
    expect(typeof provider.confine).toBe("function")
  })

  it("read-only confine wraps the command under the runner (enforcing argv, partial)", () => {
    const provider = createWindowsAclSandbox({ writableDirs: [process.cwd()], mode: "read-only" })
    const confined = provider.confine(["pwsh", "/Command", "x"], readOnly)
    // The argv prefix is the source-launch runner invocation (dsh's dev flow:
    // [node, --import <absolute tsx loader file URL>, <runner entry>, ...]).
    // F1 (m55 final review): the loader MUST be an absolute file URL, never the
    // bare `tsx/esm` specifier — the confined child spawns with cwd = the
    // assembly workspace (D1), which may lie outside any node_modules tree, and
    // a cwd-resolved bare specifier dies with ERR_MODULE_NOT_FOUND before the
    // runner starts. If a built-entry launch path is ever adopted, argv[3]
    // becomes the built lib/runner.js — this assertion (and the /runner\.ts$/
    // match below) must then be relaxed.
    expect(confined.argv[0]).toBe(process.execPath)
    expect(confined.argv[1]).toBe("--import")
    expect(confined.argv[2]).toMatch(/^file:\/\/\/.*\/tsx\/dist\/esm\/index\.mjs$/)
    expect(confined.argv[3]).toMatch(/runner\.ts$/)
    expect(confined.argv.slice(4)).toEqual([
      "--workspace", process.cwd(),
      "--temp", tmpdir(),
      "--mode", "read-only",
      "--",
      "pwsh", "/Command", "x",
    ])
    expect(confined.enforcement).toBe("partial")
    expect(confined.denialSignatures).toEqual(["access is denied", "access to the path", "permission denied"])
    expect(confined.runnerFailureRules).toEqual([
      { allowedExitCodes: [127], fatalSignatures: ["windows-acl-run: "] },
      { allowedExitCodes: [DLL_INIT_FAILED], fatalSignatures: ["couldn't create signal pipe"] },
    ])
  })
  it("rejects malformed cmd-verbatim before returning a runner invocation", () => {
    const provider = createWindowsAclSandbox({ writableDirs: [], mode: "read-only" })
    expect(() => provider.confineExecution(["C:\\bin\\tool.exe", "/d", "/s", "/c", "echo x"], readOnly,
      "cmd-verbatim")).toThrow(/cmd-verbatim/)
    provider.dispose()
  })

  // The child-level counterpart of the runner rule above: the runner STARTED
  // and mirrored its child's status, so the runner signature never appears —
  // the evidence is the MSYS fatal line on the child's own stderr. Without a
  // rule for it, exec hands the caller a bare 0xC0000142 and nothing says the
  // sandbox is why the command never ran.
  it("classifies an MSYS child that died in initialization under the token", () => {
    const provider = createWindowsAclSandbox({ writableDirs: [process.cwd()], mode: "workspace-write" })
    const confined = provider.confine(["bash.exe", "-c", "echo hi"], { mode: "workspace-write", workspaceRoot: process.cwd() })
    expect(classifyRunnerFailure({ exitCode: DLL_INIT_FAILED, stderr: { text: MSYS_SIGNAL_PIPE_FATAL } }, confined.runnerFailureRules))
      .toEqual({ detail: MSYS_SIGNAL_PIPE_FATAL })
  })

  it("keeps that rule exit-gated: the same fatal under another status is an ordinary failure", () => {
    const provider = createWindowsAclSandbox({ writableDirs: [process.cwd()], mode: "workspace-write" })
    const confined = provider.confine(["bash.exe", "-c", "echo hi"], { mode: "workspace-write", workspaceRoot: process.cwd() })
    // A confined command may legitimately exit non-zero AND print a line that
    // happens to carry the signature (e.g. `grep "couldn't create signal pipe"`).
    // Claims about the SANDBOX require the status that only this death produces.
    expect(classifyRunnerFailure({ exitCode: 1, stderr: { text: MSYS_SIGNAL_PIPE_FATAL } }, confined.runnerFailureRules))
      .toBeUndefined()
  })

  it("keeps that rule signature-gated: STATUS_DLL_INIT_FAILED alone stays an ordinary failure", () => {
    const provider = createWindowsAclSandbox({ writableDirs: [process.cwd()], mode: "workspace-write" })
    const confined = provider.confine(["bash.exe", "-c", "echo hi"], { mode: "workspace-write", workspaceRoot: process.cwd() })
    // A native command can die in DLL init for reasons that have nothing to do
    // with the restriction (a missing dependency, say). Blaming the sandbox for
    // those would send the model to a wider mode that cannot help.
    expect(classifyRunnerFailure({ exitCode: DLL_INIT_FAILED, stderr: { text: "The code execution cannot proceed because foo.dll was not found." } }, confined.runnerFailureRules))
      .toBeUndefined()
  })

  it("agentless workspace-write passes no SID flags (the runner owns a fresh private temp per execution)", () => {
    const provider = createWindowsAclSandbox({ writableDirs: [process.cwd()], mode: "workspace-write" })
    const confined = provider.confine(["node", "-e", "1"], { mode: "workspace-write", workspaceRoot: process.cwd() })
    const tail = confined.argv.slice(4)
    expect(tail.slice(0, 6)).toEqual([
      "--workspace", process.cwd(),
      "--temp", tmpdir(),
      "--mode", "workspace-write",
    ])
    expect(tail).not.toContain("--write-sid")
    expect(tail).not.toContain("--temp-write-sid")
    expect(tail.slice(-4)).toEqual(["--", "node", "-e", "1"])
    expect(confined.enforcement).toBe("partial")
    expect(confined.denialSignatures).toEqual(["access is denied", "access to the path", "permission denied"])
  })

  it("constructions with a missing writable dir fail closed", () => {
    expect(() => createWindowsAclSandbox({ writableDirs: ["Z:\\definitely-missing-dir-$"], mode: "read-only" }))
      .toThrow(/is not a directory/)
  })

  it("dispose() then confine() throws SandboxUnavailableError (fail-closed)", () => {
    const provider = createWindowsAclSandbox({ writableDirs: [process.cwd()], mode: "read-only" })
    provider.dispose()
    expect(() => provider.confine(["echo", "hi"], readOnly)).toThrow(SandboxUnavailableError)
  })

  it("dispose() is idempotent (double dispose does not throw, even with no materialized grants)", () => {
    const provider = createWindowsAclSandbox({ writableDirs: [process.cwd()], mode: "read-only" })
    expect(() => { provider.dispose(); provider.dispose() }).not.toThrow()
  })
  it("keeps failed no-temp grant teardown reachable for retry and closes new admission", () => {
    const fixture = mkdtempSync(join(resolve(process.cwd(), "../..", ".tmp"), "sandbox-redesign-acl-retry-"))
    const project = join(fixture, "project")
    const scratch = join(fixture, "scratch")
    mkdirSync(project); mkdirSync(scratch)
    let attempts = 0
    const fake = { add() {}, dispose() { attempts++; if (attempts === 1) throw new Error("release failed") } } as unknown as AclWriteGrant
    const create = vi.spyOn(AclWriteGrant, "create").mockReturnValue(fake)
    try {
      const provider = createWindowsAclSandbox({ writableDirs: [], mode: "read-only", privateTempRoot: scratch,
        disablePrivateTempWrites: true })
      provider.confineExecution(["C:\\Windows\\System32\\cmd.exe", "/d", "/s", "/c", "echo x"],
        { mode: "workspace-write", workspaceRoot: project, sessionId: "fixture" }, "cmd-verbatim")
      expect(() => provider.dispose()).toThrow(/grant cleanup/)
      expect(() => provider.confine(["echo", "x"], { mode: "read-only", workspaceRoot: project })).toThrow(/disposed/)
      expect(() => provider.dispose()).not.toThrow()
      expect(attempts).toBe(2)
    } finally { create.mockRestore(); rmSync(fixture, { recursive: true, force: true }) }
  })
  it("retains a partial workspace grant when add and immediate cleanup both fail", () => {
    const fixture = mkdtempSync(join(resolve(process.cwd(), "../..", ".tmp"), "sandbox-redesign-acl-partial-"))
    const project = join(fixture, "project")
    const scratch = join(fixture, "scratch")
    mkdirSync(project); mkdirSync(scratch)
    let releases = 0
    const fake = { add() { throw new Error("post-apply failure") }, dispose() {
      releases++
      if (releases < 3) throw new Error("SID cleanup failed")
    } } as unknown as AclWriteGrant
    const create = vi.spyOn(AclWriteGrant, "create").mockReturnValue(fake)
    try {
      const provider = createWindowsAclSandbox({ writableDirs: [], mode: "read-only", privateTempRoot: scratch,
        disablePrivateTempWrites: true })
      const policy = { mode: "workspace-write" as const, workspaceRoot: project, sessionId: "fixture" }
      expect(() => provider.confineExecution(["C:\\Windows\\System32\\cmd.exe", "/d", "/s", "/c", "echo x"],
        policy, "cmd-verbatim")).toThrow(/cleanup also failed/)
      expect(() => provider.confine(["echo", "x"], policy)).toThrow(/closing/)
      expect(() => provider.dispose()).toThrow(/grant cleanup incomplete/)
      expect(() => provider.confine(["echo", "x"], policy)).toThrow(/closing/)
      expect(() => provider.dispose()).not.toThrow()
      expect(releases).toBe(3)
      expect(create).toHaveBeenCalledTimes(1)
    } finally { create.mockRestore(); rmSync(fixture, { recursive: true, force: true }) }
  })
})
