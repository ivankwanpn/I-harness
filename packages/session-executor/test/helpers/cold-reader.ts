import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { createDurableSessionLoader, createSessionService } from "../../src/index.ts"
import type { ModelClient } from "@i-harness/llm-seam"

/** Real live writer and owned JSONL. Only the first cold read's latency is
 * controlled, so the same overlap can exercise recovering and immutable reads. */
export async function coldReaderFixture() {
  const root = await mkdtemp(join(tmpdir(), "ih-cold-reader-")), store = join(root, "sessions"), id = "owned"
  const coordinator = createSessionCoordinator(createJsonlBackend(store), { maxDelayMs: 60_000, lock: { enabled: process.platform === "win32", lockRoot: store } })
  await coordinator.create({ sessionId: id })
  const entered = Promise.withResolvers<void>(), releaseRead = Promise.withResolvers<void>(), streaming = Promise.withResolvers<void>(), releaseModel = Promise.withResolvers<void>()
  let first = true, turn: Promise<void> | undefined
  async function inspect<T>(read: () => Promise<T>, immutable: boolean): Promise<T> {
    if (!first) return read()
    first = false
    // The immutable route returns a genuinely earlier durable prefix. Consumers
    // must prefer the newly published live session after this await finishes.
    const captured = immutable ? await read() : undefined
    entered.resolve()
    await releaseRead.promise
    return immutable ? captured! : read()
  }
  const observed = { ...coordinator,
    load: (sessionId: string) => inspect(() => coordinator.load(sessionId), false),
    loadOwned: (sessionId: string) => inspect(() => coordinator.loadOwned(sessionId), false),
    snapshot: (sessionId: string) => inspect(() => coordinator.snapshot!(sessionId), true),
  }
  const model: ModelClient = { async *stream() {
    yield { type: "reasoning", text: "Owned live reasoning" }
    streaming.resolve(); await releaseModel.promise
    yield { type: "text/chunk", text: "Owned result" }; yield { type: "end" }
  } }
  const service = createSessionService({ workspace: root, coordinator: observed, sandbox: "read-only", sessionFor: createDurableSessionLoader(observed),
    modelBindingFor: async () => ({ status: "ready", binding: { model, providerId: "owned", modelId: "held", label: "Owned fixture", contextWindow: 100_000 } }) })
  return { root, store, id, coordinator, observed, service, entered: entered.promise, releaseRead: releaseRead.resolve,
    contents: () => readFile(join(store, `${id}.jsonl`), "utf8"),
    async startTurn() { turn = service.submit(id, "Owned prompt", new AbortController().signal); await streaming.promise; await coordinator.flush(id) },
    async finishTurn() { releaseModel.resolve(); await turn; await coordinator.flush(id) },
    async close() { releaseRead.resolve(); releaseModel.resolve(); await turn?.catch(() => {}); await service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) },
  }
}
