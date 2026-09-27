import { expect, it } from "vitest"
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createContext } from "@i-harness/core-plugin"
import { createHookRegistry, sha256File } from "../src/index.ts"

it("updates grants on the same registry without replaying session lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-hook-refresh-"))
  const script = join(root, "hook.cjs"), output = join(root, "calls.txt"), configPath = join(root, "hooks.json")
  await writeFile(script, `require('node:fs').appendFileSync(${JSON.stringify(output)}, 'x'); console.log('{}')`)
  const sha256 = await sha256File(script)
  await writeFile(configPath, JSON.stringify({ version: 1, handlers: ["notification", "session/start", "session/end"].map((event) => ({ id: event, event, type: "command", command: { cmd: process.execPath, args: [script] }, trust: { script, sha256 }, timeoutMs: 5000 })) }))
  const registry = await createHookRegistry(createContext(), { configPath, configDir: root, approvals: { isApproved: () => false, approve() {}, revoke() {}, list: () => [] }, report: () => {} })
  try {
    await registry.fire("notification", { message: "before" })
    await expect(readFile(output, "utf8")).rejects.toThrow()
    await registry.refreshTrust({ isApproved: () => true })
    await registry.fire("notification", { message: "approved" })
    expect(await readFile(output, "utf8")).toBe("x")
    await registry.refreshTrust({ isApproved: () => false })
    await registry.fire("notification", { message: "revoked" })
    expect(await readFile(output, "utf8")).toBe("x")
  } finally { await registry.dispose(); await rm(root, { recursive: true, force: true }) }
})
