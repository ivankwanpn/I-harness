import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { createDraftSession } from "../src/draft-session.ts"
it("deduplicates explicit draft creation across concurrent retries and host restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-draft-session-"))
  let coordinator = createSessionCoordinator(createJsonlBackend(root))
  try {
    const create = createDraftSession(coordinator)
    const [first, retry] = await Promise.all([create("draft-token-12345678"), create("draft-token-12345678")])
    expect(first.sessionId).toBe(retry.sessionId)
    await coordinator.close()
    coordinator = createSessionCoordinator(createJsonlBackend(root))
    expect(await createDraftSession(coordinator)("draft-token-12345678")).toEqual(first)
    expect(await coordinator.list()).toEqual([first.sessionId])
    await expect(createDraftSession(coordinator)("short")).rejects.toThrow(/token/)
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
