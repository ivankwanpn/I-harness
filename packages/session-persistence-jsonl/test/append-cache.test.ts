import { expect, it } from "vitest"
import { appendFileSync, mkdtempSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createJsonlBackend } from "../src/index.ts"
import { composeJsonlTaskTransitionCoordinator } from "../src/backend-factory.ts"
import { taskDocumentStorageContract } from "../../subagent/src/task/storage-contract.ts"
import type { SessionEvent } from "@i-harness/core-session"

const event = (value: Record<string, unknown>) => value as unknown as SessionEvent

it("serves repeated appends from the decoded journal cache and reads every event back", async () => {
  const root = mkdtempSync(join(tmpdir(), "ih-append-cache-"))
  const backend = createJsonlBackend(root)
  const coordinator = composeJsonlTaskTransitionCoordinator(backend, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    await coordinator.create({ sessionId: "s" })
    const appended = [
      event({ type: "turn/start" }),
      event({ type: "user/message", text: "a" }),
      event({ type: "assistant/message", text: "b" }),
      event({ type: "turn/end" }),
      event({ type: "turn/start" }),
    ]
    for (const one of appended) await backend.append("s", [one])
    const read = await backend.read("s")
    expect(read.events.map(entry => entry.type)).toEqual(appended.map(entry => entry.type))
    expect(read.events.map(entry => entry.seq)).toEqual([0, 1, 2, 3, 4])
  } finally {
    await coordinator.close()
  }
})

it("invalidates the cache when the file size changes externally", async () => {
  const root = mkdtempSync(join(tmpdir(), "ih-append-cache-"))
  const backend = createJsonlBackend(root)
  const coordinator = composeJsonlTaskTransitionCoordinator(backend, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    await coordinator.create({ sessionId: "s" })
    await backend.append("s", [event({ type: "turn/start" })])
    const file = (readdirSync(root, { recursive: true }) as string[]).find(name => String(name).endsWith(".jsonl"))!
    appendFileSync(join(root, String(file)), "garbage")
    await expect(backend.append("s", [event({ type: "turn/end" })])).rejects.toMatchObject({ code: "JOURNAL_RECOVERY_REQUIRED" })
  } finally {
    await coordinator.close()
  }
})
