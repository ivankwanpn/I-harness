import { expect, it, vi } from "vitest"
import { mkdirSync, mkdtempSync } from "node:fs"
import { resolve } from "node:path"
const owner = vi.hoisted(() => ({ attempts: 0 }))
vi.mock("@i-harness/session-executor", async importOriginal => {
  const actual = await importOriginal<typeof import("@i-harness/session-executor")>()
  return { ...actual, async createSessionAssembly(...args: Parameters<typeof actual.createSessionAssembly>) {
    const assembly = await actual.createSessionAssembly(...args)
    const dispose = assembly.dispose
    assembly.dispose = async () => { if (++owner.attempts === 1) throw new Error("cleanup incomplete"); await dispose() }
    return assembly
  } }
})
import { runHeadless } from "../src/run.ts"

it("rejects headless cleanup with a retained explicit retry", async () => {
  const parent = resolve(".tmp"); mkdirSync(parent, { recursive: true })
  const workspace = mkdtempSync(resolve(parent, "sandbox-redesign-cli-cleanup-"))
  vi.stubEnv("IH_CONFIG_DIR", workspace)
  try {
    const failure = await runHeadless("hello", { workspace, modelPolicy: "test-mock", approveAll: true }).then(() => undefined, error => error)
    expect(failure).toBeInstanceOf(Error)
    expect(typeof failure.retryCleanup).toBe("function")
    await failure.retryCleanup()
    expect(owner.attempts).toBe(2)
  } finally { vi.unstubAllEnvs() }
})
