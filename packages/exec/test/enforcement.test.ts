import { describe, expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { registerExec } from "../src/index.ts"
import { SandboxUnavailableError, type SandboxProvider } from "@i-harness/sandbox"

describe("exec readIsolation gate", () => {
  it("run() with readIsolation policy + no-capability provider → SandboxUnavailableError", async () => {
    const provider: SandboxProvider = {
      confine(argv, _policy) {
        return { argv: [...argv], enforcement: "partial", denialSignatures: [], runnerFailureRules: [] }
      },
    }
    const exec = registerExec(createContext(), { sandbox: provider })
    await expect(exec.run({
      argv: ["node", "-e", "0"],
      sandbox: { mode: "workspace-write", workspaceRoot: "C:/w", requireReadIsolation: true },
    })).rejects.toThrow(SandboxUnavailableError)
  })
})

it("keeps the read-isolation refusal authoritative with pending steer", async () => {
  let subscriptions = 0
  const exec = registerExec(createContext(), { sandbox: { confine(argv) { return { argv: [...argv], enforcement: "partial", denialSignatures: [], runnerFailureRules: [] } } } })
  await expect(exec.run({ argv: ["node", "-e", "0"], sandbox: { mode: "workspace-write", workspaceRoot: "C:/w", requireReadIsolation: true } }, {
    promotionWake: { pending: () => true, subscribe() { subscriptions++; return () => {} } },
  })).rejects.toThrow(SandboxUnavailableError)
  expect(subscriptions).toBe(0)
  expect(exec.listJobs()).toEqual([])
  await exec.dispose()
})
