import { describe, expect, it } from "vitest"
import { createSessionService } from "../src/service.ts"
import { mkdtempSync, mkdirSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createMockClient } from "@i-harness/llm-mock"

describe("live service sandbox mode", () => {
  it("updates existing assemblies and new assemblies without a restart", async () => {
    const service = createSessionService({ workspace: process.cwd(), modelPolicy: "test-mock", sandbox: "danger-full-access", allowRuntimeSandboxChanges: true })
    try {
      const existing = await service.assemblyFor("existing")
      service.updateSandboxMode("read-only")
      expect(existing.session.events.filter((event) => event.type === "sandbox/mode").at(-1)).toMatchObject({ mode: "read-only" })
      const created = await service.assemblyFor("created")
      expect(created.session.events.filter((event) => event.type === "sandbox/mode").at(-1)).toMatchObject({ mode: "read-only" })
    } finally { await service.close() }
  })
  it("does not lose a sandbox change while an assembly is mounting extensions", async () => {
    let entered!: () => void
    let release!: () => void
    const mounted = new Promise<void>((resolve) => { entered = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    const service = createSessionService({
      workspace: process.cwd(), modelPolicy: "test-mock", sandbox: "danger-full-access", allowRuntimeSandboxChanges: true,
      extensionsFor: async () => ({ options: {}, mount: async () => { entered(); await gate } }),
    })
    try {
      const creating = service.assemblyFor("racing")
      await mounted
      service.updateSandboxMode("read-only")
      release()
      const assembly = await creating
      expect(assembly.session.events.filter((event) => event.type === "sandbox/mode").at(-1)).toMatchObject({ mode: "read-only" })
    } finally { release(); await service.close() }
  })
  it("enforces a live tightening on the next real write tool call", async () => {
    const root = mkdtempSync(join(tmpdir(), "ih-live-sandbox-"))
    const workspace = join(root, "workspace")
    mkdirSync(workspace)
    const outside = join(root, "outside.txt")
    const model = createMockClient([
      { role: "assistant", toolCalls: [{ name: "write", args: { path: outside, text: "escaped" } }] },
      { role: "assistant", text: "done" },
    ])
    const service = createSessionService({ workspace, model, sandbox: "danger-full-access", approveAll: true, allowRuntimeSandboxChanges: true })
    try {
      await service.assemblyFor("session")
      service.updateSandboxMode("read-only")
      await service.submit("session", "write outside", new AbortController().signal)
      expect(existsSync(outside)).toBe(false)
      const session = service.liveSession("session")!
      expect(session.events.some((event) => event.type === "tool/result" && JSON.stringify(event).includes("FS_SANDBOX_DENIED"))).toBe(true)
    } finally { await service.close(); rmSync(root, { recursive: true, force: true }) }
  })
})
