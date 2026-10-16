import { expect, it } from "vitest"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import type { ModelClient } from "@i-harness/llm-seam"
import { createSessionAssembly } from "../src/assembly.ts"

it("production main and actual child read reconstruct source-backed multilingual pages", async () => {
  const root = await mkdtemp(join(tmpdir(), "production-file-pages-"))
  const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
  await coordinator.create({ sessionId: "parent" })
  const text = '中🙂"\n'.repeat(13000), path = join(root, "large.txt")
  await writeFile(path, text)
  let childFull = "", childOffset = 0, childDigest: string | undefined, childPages = 0
  const child: ModelClient = { async *stream(request) {
    const previous = request.messages.filter(m => m.role === "tool").at(-1)
    if (previous?.role === "tool") {
      if (typeof previous.content !== "string") throw new Error("Expected text file result")
      const page = JSON.parse(previous.content)
      expect(Buffer.byteLength(previous.content, "utf8")).toBeLessThanOrEqual(64000)
      expect(page.content).not.toContain("�")
      childFull += page.content; childPages++
      childDigest = page.digest
      if (!page.truncated) { yield { type: "text/chunk", text: "read complete" }; yield { type: "end" }; return }
      expect(page.next_offset_bytes).toBeGreaterThan(childOffset)
      childOffset = page.next_offset_bytes
    }
    yield { type: "tool_call", call: { id: `page-${childPages}`, name: "read", args: { path, ...(childPages ? { offset_bytes: childOffset, digest: childDigest } : {}) } } }
    yield { type: "end" }
  } }
  const main: ModelClient = { async *stream() { yield { type: "text/chunk", text: "done" }; yield { type: "end" } } }
  const assembly = await createSessionAssembly({ workspace: root, coordinator, sessionId: "parent", model: main,
    roleSelectionFor: role => role === "explore" ? { provider: "local", model: "child" } : undefined,
    allowSubagentModelSelection: true, resolveRoleModel: async () => ({ status: "ready", binding: { client: child } }),
  })
  try {
    let offset = 0, digest: string | undefined, full = "", pages = 0
    for (;;) {
      const page = (await assembly.tools.execute({ name: "read", args: { path, ...(pages ? { offset_bytes: offset, digest } : {}) } })).output as any
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(64000)
      full += page.content; pages++; digest = page.digest
      if (!page.truncated) break
      expect(page.next_offset_bytes).toBeGreaterThan(offset); offset = page.next_offset_bytes
    }
    expect(pages).toBeGreaterThan(1); expect(full).toBe(text)
    const result = await assembly.tools.get("spawn_agent")!.execute({ message: "Read the full file by pages", task_name: "reader", agent_type: "explore", background: false }, { sessionId: "parent" }) as any
    expect(result.outcome).toBe("completed")
    expect(childPages).toBeGreaterThan(1); expect(childFull).toBe(text)
    await writeFile(path, "changed")
    expect((await assembly.tools.execute({ name: "read", args: { path, digest, offset_bytes: offset } })).output).toMatchObject({ code: "FS_STALE_VERSION" })
  } finally { await assembly.dispose(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
