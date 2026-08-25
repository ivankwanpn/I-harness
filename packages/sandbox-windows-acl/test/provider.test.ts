import { describe, expect, it } from "vitest"
import { tmpdir } from "node:os"
import { SandboxUnavailableError } from "@i-harness/sandbox"
import { createWindowsAclSandbox } from "../src/index.ts"
import type { SandboxPolicy } from "@i-harness/sandbox"

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
    // [node, --import tsx/esm, <runner entry>, ...]). If a built-entry launch
    // path is ever adopted, argv[3] becomes the built lib/runner.js — this
    // assertion (and the /runner\.ts$/ match below) must then be relaxed.
    expect(confined.argv.slice(0, 4)).toEqual([process.execPath, "--import", "tsx/esm", confined.argv[3]])
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
    expect(confined.runnerFailureRules).toEqual([{ allowedExitCodes: [127], fatalSignatures: ["windows-acl-run: "] }])
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
})
