import { describe, expect, it } from "vitest"
import { createExecService } from "../src/index.ts"
import { SandboxUnavailableError, type SandboxProvider } from "@i-harness/sandbox"

describe("exec readIsolation gate", () => {
  it("run() with readIsolation policy + no-capability provider → SandboxUnavailableError", async () => {
    const provider: SandboxProvider = {
      confine(argv, _policy) {
        return { argv: [...argv], enforcement: "partial", denialSignatures: [], runnerFailureRules: [] }
      },
    }
    const exec = createExecService({ sandbox: provider })
    await expect(exec.run({
      argv: ["node", "-e", "0"],
      sandbox: { mode: "workspace-write", workspaceRoot: "C:/w", requireReadIsolation: true },
    })).rejects.toThrow(SandboxUnavailableError)
  })
})
