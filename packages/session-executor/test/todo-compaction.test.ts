import { expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { append, deriveMessages } from "@i-harness/core-session"
import { createCompactionEngine } from "@i-harness/compaction"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "../../session-persistence-jsonl/src/index.ts"
import type { LLMRequest, ModelClient } from "@i-harness/llm-seam"
import { createSessionService } from "../src/service.ts"
import { createDurableSessionLoader } from "../src/durable-session.ts"

it("sends the durable Todo after summary compaction, human edits, reset, clearing, and restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-todo-context-"))
  const store = join(root, "sessions")
  const requests: LLMRequest[] = []
  const model: ModelClient = { async *stream(request) { requests.push(request); yield { type: "text/chunk", text: "ok" }; yield { type: "end" } } }
  const summarizer: ModelClient = { async *stream() { yield { type: "text/chunk", text: "A summary that deliberately omits all Todo details." }; yield { type: "end" } } }
  let coordinator = createSessionCoordinator(createJsonlBackend(store))
  await coordinator.create({ sessionId: "s" })
  let service = createSessionService({ workspace: root, coordinator, sessionFor: createDurableSessionLoader(coordinator), model, contextWindow: 100_000, compact: { auto: false, summarizationModel: summarizer, minSummaryChars: 1 } })
  try {
    const assembly = await service.assemblyFor("s")
    const session = assembly.session
    append(session, { type: "turn/start" })
    append(session, { type: "user/message", text: "continue planned work" })
    append(session, { type: "todo/write", version: 1, items: [{ content: "Finish durable Todo editor", status: "in_progress" }, { content: "Verify saved state", status: "pending" }] })
    append(session, { type: "assistant/message", text: "The plan is ready." })
    append(session, { type: "turn/end" })
    const compacted = await assembly.compactNow()
    expect(compacted.compacted).toBe(true)
    expect(compacted.shadowedSeqs).toContain(2)
    expect(JSON.stringify(deriveMessages(session))).not.toContain("Finish durable Todo editor")
    await service.submit("s", "continue after compression", new AbortController().signal)
    expect(requests.at(-1)!.systemPrompt).toContain('"content":"Finish durable Todo editor","status":"in_progress"')
    expect(requests.at(-1)!.systemPrompt).toContain('"content":"Verify saved state","status":"pending"')

    // A human edit writes the same durable event as the desktop CAS path.
    append(session, { type: "todo/write", version: 1, items: [{ content: "Human corrected next step", status: "pending" }] })
    const humanTodoSeq = session.events.at(-1)!.seq!
    append(session, { type: "assistant/message", text: "A retained final context line." })
    const engine = createCompactionEngine({ model: summarizer, config: { contextWindow: 100_000, minSummaryChars: 1 } })
    const reset = await engine.resetWindow(session, 1)
    expect(reset.reset).toBe(true)
    expect(reset.shadowedSeqs).toContain(humanTodoSeq)
    await service.submit("s", "continue after reset", new AbortController().signal)
    expect(requests.at(-1)!.systemPrompt).toContain('"content":"Human corrected next step","status":"pending"')
    expect(requests.at(-1)!.systemPrompt).not.toContain("Finish durable Todo editor")

    append(session, { type: "todo/write", version: 1, items: [] })
    await service.submit("s", "the list is cleared", new AbortController().signal)
    expect(requests.at(-1)!.systemPrompt).toContain('"todos":[]')
    expect(requests.at(-1)!.systemPrompt).not.toContain("Human corrected next step")
    await coordinator.flush("s")
    await service.close()
    await coordinator.close()

    coordinator = createSessionCoordinator(createJsonlBackend(store))
    service = createSessionService({ workspace: root, coordinator, sessionFor: createDurableSessionLoader(coordinator), model })
    await service.submit("s", "continue after restart", new AbortController().signal)
    expect(requests.at(-1)!.systemPrompt).toContain('"todos":[]')
    expect(requests.at(-1)!.systemPrompt).not.toContain("Human corrected next step")
    expect((await coordinator.snapshot!("s")).session.events.filter((event) => event.type === "todo/write")).toHaveLength(3)
  } finally { await service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
