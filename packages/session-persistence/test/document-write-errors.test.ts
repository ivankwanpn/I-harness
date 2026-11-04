import { expect, it } from "vitest"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createJsonlBackend } from "../../session-persistence-jsonl/src/index.ts"
import { composeJsonlTaskTransitionCoordinator } from "../../session-persistence-jsonl/src/backend-factory.ts"
import { taskDocumentStorageContract } from "../../subagent/src/task/storage-contract.ts"

it("reports a document write failure instead of resolving as success", async () => {
  const root = mkdtempSync(join(tmpdir(), "ih-doc-write-"))
  const coordinator = composeJsonlTaskTransitionCoordinator(createJsonlBackend(root), { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    // A directory at the document path makes the atomic write fail; before the
    // fix putDocument reported it and resolved, so callers saw a successful save.
    mkdirSync(join(root, "session-title", "x.doc.jsonl"), { recursive: true })
    await expect(coordinator.putDocument("session-title/x", { title: "t" })).rejects.toThrow()
    // The failed save must not leave its temporary file behind.
    expect(readdirSync(join(root, "session-title")).filter(name => name.endsWith(".tmp"))).toEqual([])
  } finally {
    await coordinator.close()
  }
})

it("writes and replaces a document with a synced temp file", async () => {
  const root = mkdtempSync(join(tmpdir(), "ih-doc-durable-"))
  const coordinator = composeJsonlTaskTransitionCoordinator(createJsonlBackend(root), { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    await coordinator.putDocument("session-title/y", { title: "first" })
    expect(JSON.parse(readFileSync(join(root, "session-title", "y.doc.jsonl"), "utf8"))).toEqual({ title: "first" })
    await coordinator.putDocument("session-title/y", { title: "second" })
    expect(JSON.parse(readFileSync(join(root, "session-title", "y.doc.jsonl"), "utf8"))).toEqual({ title: "second" })
    expect(readdirSync(join(root, "session-title")).filter(name => name.endsWith(".tmp"))).toEqual([])
  } finally {
    await coordinator.close()
  }
})
