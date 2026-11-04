import { expect, it } from "vitest"
import { appendFileSync, mkdtempSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createJsonlBackend } from "../src/index.ts"
import { composeJsonlTaskTransitionCoordinator } from "../src/backend-factory.ts"
import { taskDocumentStorageContract } from "../../subagent/src/task/storage-contract.ts"

it("names a torn tail as not-issued and stays writable after the load repairs it", async () => {
  const root = mkdtempSync(join(tmpdir(), "ih-torn-"))
  const backend = createJsonlBackend(root)
  const coordinator = composeJsonlTaskTransitionCoordinator(backend, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    await coordinator.create({ sessionId: "s" })
    await coordinator.append("s", [{ type: "turn/start" }])
    const file = (readdirSync(root, { recursive: true }) as string[]).find(name => String(name).endsWith(".jsonl"))
    expect(file).toBeDefined()
    appendFileSync(join(root, String(file)), '{"type":"turn/end"')

    await expect(backend.append("s", [{ type: "turn/end" }])).rejects.toMatchObject({ code: "JOURNAL_RECOVERY_REQUIRED" })

    await coordinator.load("s")
    await expect(backend.append("s", [{ type: "turn/end" }])).resolves.toBeUndefined()
  } finally {
    await coordinator.close()
  }
})
