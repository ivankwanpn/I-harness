import { expect, it } from "vitest"
import { snapshotProcessSpec } from "../src/process-spec.ts"

function fixture() {
  return { argv: ["C:\\Git\\usr\\bin\\bash.exe", "-i"], cwd: "D:\\work", env: { EMPTY: "" }, owner: { sessionId: "msys-owner" },
    transport: "pty" as const, lifetime: "retain-tree" as const, argumentEncoding: "crt" as const, pty: { cols: 80, rows: 24 },
    msysPty: { runtime: { path: "C:\\Git\\usr\\bin\\msys-2.0.dll", sha256: "1".repeat(64) },
      executable: { path: "C:\\Git\\usr\\bin\\bash.exe", sha256: "2".repeat(64) },
      resolution: { kind: "git-bash-shim" as const, original: { path: "C:\\Git\\bin\\bash.exe", sha256: "3".repeat(64) },
        configuration: { path: "C:\\Git\\etc\\git-bash.config", sha256: null as string | null } } },
  }
}

it("retains and detaches the complete MSYS PTY executable/runtime/configuration observations before admission awaits", () => {
  const input = fixture()
  const captured = snapshotProcessSpec(input) as typeof input
  input.msysPty.runtime.path = "C:\\changed.dll"
  input.msysPty.executable.sha256 = "4".repeat(64)
  input.msysPty.resolution.original.path = "C:\\changed.exe"
  input.msysPty.resolution.configuration.sha256 = "5".repeat(64)
  expect(captured.msysPty).toEqual({ runtime: { path: "C:\\Git\\usr\\bin\\msys-2.0.dll", sha256: "1".repeat(64) },
    executable: { path: "C:\\Git\\usr\\bin\\bash.exe", sha256: "2".repeat(64) },
    resolution: { kind: "git-bash-shim", original: { path: "C:\\Git\\bin\\bash.exe", sha256: "3".repeat(64) },
      configuration: { path: "C:\\Git\\etc\\git-bash.config", sha256: null } } })
  expect(Object.isFrozen(captured.msysPty)).toBe(true)
  expect(Object.isFrozen(captured.msysPty.resolution.configuration)).toBe(true)
})

it.each(["pipe", "wsl", "verbatim", "invalid hash", "relative runtime", "different executable", "unknown resolution", "missing config observation"] as const)("rejects invalid MSYS PTY binding: %s", mode => {
  const input: any = fixture()
  if (mode === "pipe") input.transport = "pipe"
  if (mode === "wsl") input.executionTarget = "wsl"
  if (mode === "verbatim") input.argumentEncoding = "cmd-verbatim"
  if (mode === "invalid hash") input.msysPty.executable.sha256 = "wrong"
  if (mode === "relative runtime") input.msysPty.runtime.path = "msys-2.0.dll"
  if (mode === "different executable") input.msysPty.executable.path = "C:\\Git\\usr\\bin\\sh.exe"
  if (mode === "unknown resolution") input.msysPty.resolution.kind = "name-only"
  if (mode === "missing config observation") delete input.msysPty.resolution.configuration
  expect(() => snapshotProcessSpec(input)).toThrow(/MSYS PTY/)
})
