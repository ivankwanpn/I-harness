import { afterEach as afterFixture, vi as fixtureVi } from 'vitest'
afterFixture(() => fixtureVi.unstubAllGlobals())
import { controlledModel } from "./controlled-model.ts"
import { expect, it } from "vitest"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { createContextOutputService } from "@i-harness/context-output"
import type { ModelClient } from "@i-harness/llm-seam"
import { createSessionAssembly, type SessionAssembly } from "../src/assembly.ts"
import { createUnmanagedTaskChildHost } from "../src/lifecycle/task-child-host.ts"
import { composeJsonlTaskTransitionCoordinator } from "../../session-persistence-jsonl/src/backend-factory.ts"
import { taskDocumentStorageContract } from "../../subagent/src/task/storage-contract.ts"
import { spawnDurable } from "./helpers/durable-spawn.ts"

it("production main and actual child read reconstruct source-backed multilingual pages", async () => {
  const root = await mkdtemp(join(tmpdir(), "production-file-pages-"))
  const coordinator = composeJsonlTaskTransitionCoordinator(createJsonlBackend(root), { lock: { enabled: true } }, taskDocumentStorageContract)
  await coordinator.create({ sessionId: "parent" })
  const output = createContextOutputService({ root: join(root, "results"), workspaceId: "fixture", config: { enabled: true, maxDiskBytes: 1 << 24 } })
  const text = '中🙂"\n'.repeat(13000), path = join(root, "large.txt")
  await writeFile(path, text)
  let childFull = "", childOffset = 0, childDigest: string | undefined, childPages = 0
  let artifactRef: unknown, artifactText = "", artifactOffset = 0
  const child: ModelClient = controlledModel(async function* (request) {
    const previous = request.messages.filter(m => m.role === "tool").at(-1)
    let next: { id: string; name: string; args: unknown }
    const processPage = (page: { content?: unknown; digest?: string; truncated?: boolean; next_offset_bytes?: number }): boolean => {
      expect(typeof page.content).toBe("string")
      expect(page.content).not.toContain("�")
      childFull += page.content as string; childPages++
      childDigest = page.digest
      if (!page.truncated) return true
      expect(page.next_offset_bytes).toBeGreaterThan(childOffset)
      childOffset = page.next_offset_bytes!
      return false
    }
    if (previous?.role === "tool") {
      if (typeof previous.content !== "string") throw new Error("Expected a text tool result")
      const payload = JSON.parse(previous.content) as Record<string, any>
      if (payload?.data && typeof payload.data === "object" && ("eof" in payload || "nextOffset" in payload)) {
        if (payload.data.kind !== "text") throw new Error("Expected a text artifact page")
        artifactText += payload.data.text
        if (payload.eof === true) {
          const page = JSON.parse(artifactText) as { content?: unknown; digest?: string; truncated?: boolean; next_offset_bytes?: number }
          artifactText = ""
          if (processPage(page)) { yield { type: "text/chunk", text: "read complete" }; yield { type: "end" }; return }
          next = { id: `page-${childPages}`, name: "read", args: { path, offset_bytes: childOffset, digest: childDigest } }
        } else {
          artifactOffset = Number(payload.nextOffset ?? artifactOffset)
          next = { id: `artifact-${childPages}-${artifactOffset}`, name: "context_output_read", args: { ref: artifactRef, offset: artifactOffset, maxBytes: 32768 } }
        }
      } else if (payload?.retention?.kind === "artifact" && payload.retention.ref) {
        artifactRef = payload.retention.ref; artifactText = ""; artifactOffset = 0
        next = { id: `artifact-${childPages}-0`, name: "context_output_read", args: { ref: artifactRef, offset: 0, maxBytes: 32768 } }
      } else {
        expect(Buffer.byteLength(previous.content, "utf8")).toBeLessThanOrEqual(64000)
        if (processPage(payload)) { yield { type: "text/chunk", text: "read complete" }; yield { type: "end" }; return }
        next = { id: `page-${childPages}`, name: "read", args: { path, offset_bytes: childOffset, digest: childDigest } }
      }
    } else next = { id: "page-0", name: "read", args: { path } }
    yield { type: "tool_call", call: next }
    yield { type: "end" }
  })
  const main: ModelClient = controlledModel(async function* () { yield { type: "text/chunk", text: "done" }; yield { type: "end" } })
  const assembly: SessionAssembly = await createSessionAssembly({ workspace: root, coordinator, sessionId: "parent", model: main,
    contextOutput: output, approveAll: true, prepareTaskChild: createUnmanagedTaskChildHost({ coordinator, policy: 'unmanaged' }),
    roleSelectionFor: role => role === "explore" ? { provider: "local", model: "child" } : undefined,
    allowSubagentModelSelection: true, resolveRoleModel: async () => ({ status: "ready", binding: { client: child, contextWindow: 100_000 } }),
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
    const { output: spawnOutput } = await spawnDurable(assembly, "parent", { message: "Read the full file by pages", task_name: "reader", agent_type: "explore", background: false })
    const result = spawnOutput as any
    expect(result.outcome).toBe("completed")
    expect(childPages).toBeGreaterThan(1); expect(childFull).toBe(text)
    await writeFile(path, "changed")
    expect((await assembly.tools.execute({ name: "read", args: { path, digest, offset_bytes: offset } })).output).toMatchObject({ code: "FS_STALE_VERSION" })
  } finally { await assembly.dispose(); await output.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
