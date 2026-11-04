import { expect, it } from "vitest"
import { mkdirSync, mkdtempSync } from "node:fs"
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
  } finally {
    await coordinator.close()
  }
})
