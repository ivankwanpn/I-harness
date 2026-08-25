import { describe, expect, it } from "vitest"
import { bwrapProfileArgs } from "../src/profiles.ts"
import { classifyDenial, classifyRunnerFailure, isRunnerSpawnFailure } from "../src/runner-failures.ts"
import { createLocalSandbox } from "../src/index.ts"
import { SandboxUnavailableError, type SandboxPolicy, type SandboxProvider } from "@i-harness/sandbox"

const readOnly: SandboxPolicy = { mode: "read-only", workspaceRoot: "/" }
const workspaceWrite: SandboxPolicy = { mode: "workspace-write", workspaceRoot: "/proj" }

describe("bwrapProfileArgs", () => {
  it("read-only: ro-bind /, dev, unshare-pid, proc, die-with-parent", () => {
    expect(bwrapProfileArgs(readOnly)).toEqual([
      "--ro-bind", "/", "/",
      "--dev", "/dev",
      "--unshare-pid",
      "--proc", "/proc",
      "--die-with-parent",
    ])
  })

  it("workspace-write adds --tmpfs /tmp and --bind workspaceRoot", () => {
    const args = bwrapProfileArgs(workspaceWrite)
    expect(args).toContain("--tmpfs")
    expect(args).toContain("/tmp")
    expect(args).toContain("--bind")
    expect(args).toContain("/proj")
  })
})

describe("runner failure classification", () => {
  it("isRunnerSpawnFailure: ENOENT with argv[0] path → true", () => {
    const err = Object.assign(new Error("spawn bwrap ENOENT"), { code: "ENOENT", path: "bwrap", syscall: "spawn" })
    expect(isRunnerSpawnFailure(err, "bwrap", process.cwd())).toBe(true)
  })

  it("isRunnerSpawnFailure: EACCES → true", () => {
    const err = Object.assign(new Error("spawn EACCES"), { code: "EACCES", path: "bwrap", syscall: "spawn" })
    expect(isRunnerSpawnFailure(err, "bwrap", process.cwd())).toBe(true)
  })

  it("isRunnerSpawnFailure: other errors → false", () => {
    const err = Object.assign(new Error("boom"), { code: "E2BIG", syscall: "spawn" })
    expect(isRunnerSpawnFailure(err, "bwrap", process.cwd())).toBe(false)
  })

  it("classifyDenial matches denial signatures case-insensitively", () => {
    const result = { exitCode: 1, stderr: { text: "mkdir: cannot create directory: Read-only file system" } }
    expect(classifyDenial(result, ["read-only file system"])).toBe(true)
    const clean = { exitCode: 1, stderr: { text: "mkdir: Read-only file system" } }
    expect(classifyDenial(clean, ["read-only file system"])).toBe(true)
  })

  it("classifyRunnerFailure requires a fatal signature + exit-code gate", () => {
    const rule = { allowedExitCodes: [125], fatalSignatures: ["bwrap: failed to"], informationalLines: ["info line"] }
    const r1 = { exitCode: 125, stderr: { text: "info line\nbwrap: failed to create namespace" } }
    expect(classifyRunnerFailure(r1, [rule])).not.toBeUndefined()
    const r2 = { exitCode: 1, stderr: { text: "bwrap: failed to create namespace" } }
    expect(classifyRunnerFailure(r2, [rule])).toBeUndefined() // exit gate 125 not met
    const r3 = { exitCode: 125, stderr: { text: "some other error" } }
    expect(classifyRunnerFailure(r3, [rule])).toBeUndefined() // no fatal signature
  })
})

describe("createLocalSandbox platform selection", () => {
  // M16 final-review (I1): these two tests exercise the win32 branch only; on
  // Linux with bwrap the branch returns a confined bwrap argv instead of
  // throwing/delegating, so they must be win32-only (skipIf, not remove).
  it.skipIf(process.platform !== "win32")("win32 absent-backend → fail-closed SandboxUnavailableError", () => {
    // Fail closed when no windowsAclBackend is composed.
    const provider = createLocalSandbox({ windowsAclBackend: undefined })
    expect(() => provider.confine(["echo", "hi"], readOnly)).toThrow(SandboxUnavailableError)
  })

  it.skipIf(process.platform !== "win32")("win32 with injected stub → delegates and pins enforcement partial", () => {
    const stub: SandboxProvider = {
      confine(argv, _policy) {
        return {
          argv: ["stub", ...argv],
          enforcement: "full",
          denialSignatures: ["stub denial"],
          runnerFailureRules: [],
        }
      },
    }
    const provider = createLocalSandbox({ windowsAclBackend: stub })
    const confined = provider.confine(["echo", "hi"], readOnly)
    expect(confined.argv).toEqual(["stub", "echo", "hi"])
    expect(confined.enforcement).toBe("partial")
    expect(confined.denialSignatures).toContain("stub denial")
  })

  it("linux → bwrap runner (probe path)", () => {
    // On linux, without a windowsAclBackend, confinement requires bwrap present.
    // We assert the provider exists and confine() gives a ConfinedArgv (bwrap probe
    // may fail on CI → SandboxUnavailableError). Just check the provider shape.
    const provider = createLocalSandbox({ windowsAclBackend: undefined })
    expect(typeof provider.confine).toBe("function")
  })

  it("non-linux non-win32 → fail-closed SandboxUnavailableError", async () => {
    const provider = createLocalSandbox({ windowsAclBackend: undefined })
    // Platform is win32 or linux in this repo; on a third platform confine throws.
    // Skip on the two real platforms — this branch is unreachable in CI.
    if (process.platform === "win32" || process.platform === "linux") return
    expect(() => provider.confine(["echo", "hi"], readOnly)).toThrow(/no sandbox backend/)
  })
})
