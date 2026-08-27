import { describe, expect, it } from "vitest"
import { assertSandboxCapable, SandboxUnavailableError, type SandboxPolicy, type SandboxProvider } from "../src/index.ts"

const policy: SandboxPolicy = { mode: "workspace-write", workspaceRoot: "C:/w" }

describe("readIsolation enforcement gate", () => {
  it("provider without capability + policy requiring it → SandboxUnavailableError", () => {
    const provider: SandboxProvider = {
      confine(_argv, _policy) {
        return { argv: ["x"], enforcement: "partial", denialSignatures: [], runnerFailureRules: [] }
      },
    }
    expect(() => assertSandboxCapable({ ...policy, requireReadIsolation: true }, provider)).toThrow(SandboxUnavailableError)
  })

  it("provider with capability + policy requiring it → pass", () => {
    const provider: SandboxProvider = {
      capabilities: { readIsolation: true },
      confine(_argv, _policy) {
        return { argv: ["x"], enforcement: "full", denialSignatures: [], runnerFailureRules: [] }
      },
    }
    expect(() => assertSandboxCapable({ ...policy, requireReadIsolation: true }, provider)).not.toThrow()
  })

  it("policy without requirement + no capability → pass (today's behavior)", () => {
    const provider: SandboxProvider = {
      confine(_argv, _policy) {
        return { argv: ["x"], enforcement: "partial", denialSignatures: [], runnerFailureRules: [] }
      },
    }
    expect(() => assertSandboxCapable(policy, provider)).not.toThrow()
  })
})
