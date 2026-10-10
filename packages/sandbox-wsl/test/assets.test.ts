import { createHash } from "node:crypto"
import { afterEach, expect, it, vi } from "vitest"
const mock = vi.hoisted(() => ({ reads: [] as string[], digest: "", bad: false, missing: false }))
vi.mock("node:fs", () => ({
  existsSync: () => true,
  readFileSync: (url:URL) => {
    mock.reads.push(url.pathname)
    if (url.pathname.endsWith("manifest.json")) {
      if (mock.missing) throw new Error("manifest missing")
      return Buffer.from(JSON.stringify({schema:1,protocol:1,worker:"runner.py",sha256:mock.bad ? "0".repeat(64) : mock.digest}))
    }
    return Buffer.from("captured trusted worker")
  },
}))
import { createWslExecutionBackend } from "../src/index.ts"
afterEach(() => { vi.unstubAllEnvs(); mock.reads.length=0; mock.bad=false; mock.missing=false })
it("packaged construction requires the fixed packaged worker and verified manifest", async () => {
  vi.stubEnv("I_HARNESS_DIST", "1")
  mock.digest=createHash("sha256").update("captured trusted worker").digest("hex")
  const backend=createWslExecutionBackend({distribution:"Ubuntu"})
  expect(mock.reads).toHaveLength(2)
  expect(mock.reads[0]).toMatch(/\/wsl-assets\/runner.py$/)
  expect(mock.reads[1]).toMatch(/\/wsl-assets\/manifest.json$/)
  await backend.dispose()
})
it("packaged construction refuses mismatched or missing worker manifests", () => {
  vi.stubEnv("I_HARNESS_DIST", "1")
  mock.bad=true
  expect(()=>createWslExecutionBackend({distribution:"Ubuntu"})).toThrow(/manifest/)
  mock.bad=false;mock.missing=true
  expect(()=>createWslExecutionBackend({distribution:"Ubuntu"})).toThrow(/manifest/)
})
