import { controlledModel } from "./controlled-model.ts"
import { completeCheckpoint } from '../../compaction/test/fixtures/checkpoint.ts'
import { recordFixture } from "./helpers.ts"
import { afterEach, expect, it, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deriveMessages } from "@i-harness/core-session"
import { createCompactionHarness } from '../../compaction/test/fixtures/engine.ts'
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "../../session-persistence-jsonl/src/index.ts"
import type { LLMRequest } from "@i-harness/llm-seam"
import { createSessionService } from "../src/service.ts"
import { createDurableSessionLoader } from "../src/durable-session.ts"

it("sends the durable Todo after summary compaction, human edits, reset, clearing, and restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-todo-context-"))
  const store = join(root, "sessions")
  const requests: LLMRequest[] = []
  const model = controlledModel(async function* (request) { requests.push(request); yield { type: "text/chunk", text: "ok" }; yield { type: "end" } })
  const summarizer = controlledModel(async function* () { yield { type: "text/chunk", text: completeCheckpoint() }; yield { type: "end" } })
  let coordinator = createSessionCoordinator(createJsonlBackend(store), { lock: { enabled: true } })
  await coordinator.create({ sessionId: "s" })
  let service = createSessionService({ workspace: root, coordinator, sessionFor: createDurableSessionLoader(coordinator), model, contextWindow: 100_000, compact: { auto: false, summarizationModel: summarizer, minSummaryChars: 1 } })
  try {
    const assembly = await service.assemblyFor("s")
    const session = assembly.session
    await recordFixture(assembly.factOwner, { type: "turn/start" })
    await recordFixture(assembly.factOwner, { type: "user/message", text: "continue planned work".repeat(200) })
    await recordFixture(assembly.factOwner, { type: "todo/write", version: 1, items: [{ content: "Finish durable Todo editor", status: "in_progress" }, { content: "Verify saved state", status: "pending" }] })
    await recordFixture(assembly.factOwner, { type: "assistant/message", text: "The plan is ready." })
    await recordFixture(assembly.factOwner, { type: "turn/end" })
    const compacted = await assembly.compactNow()
    expect(compacted.compacted).toBe(true)
    expect(compacted.shadowedSeqs).toEqual([1])
    expect(JSON.stringify(deriveMessages(session))).not.toContain("Finish durable Todo editor")
    await service.submit("s", "continue after compression", new AbortController().signal)
    expect(requests.at(-1)!.systemPrompt).toContain('"content":"Finish durable Todo editor","status":"in_progress"')
    expect(requests.at(-1)!.systemPrompt).toContain('"content":"Verify saved state","status":"pending"')
    const unchangedInstructions = requests.at(-1)!.systemPrompt
    await recordFixture(assembly.factOwner, { type: "todo/write", version: 1, items: [{ content: "Finish durable Todo editor", status: "in_progress" }, { content: "Verify saved state", status: "pending" }] })
    await service.submit("s", "continue with the identical plan", new AbortController().signal)
    expect(requests.at(-1)!.systemPrompt).toBe(unchangedInstructions)

    // A human edit writes the same durable event as the desktop CAS path.
    await recordFixture(assembly.factOwner, { type: "todo/write", version: 1, items: [{ content: "Human corrected next step", status: "pending" }] })
    const humanTodoSeq = session.events.at(-1)!.seq!
    await recordFixture(assembly.factOwner, { type: "assistant/message", text: "A retained final context line." })

    const engine = createCompactionHarness({ model: summarizer, config: { contextWindow: 100_000, minSummaryChars: 1 }, factOwner: assembly.factOwner })
    const reset = await engine.resetWindow(session, 1)
    expect(reset.reset).toBe(true)
    expect(reset.shadowedSeqs).not.toContain(humanTodoSeq)
    await service.submit("s", "continue after reset", new AbortController().signal)
    expect(requests.at(-1)!.systemPrompt).toContain('"content":"Human corrected next step","status":"pending"')
    expect(requests.at(-1)!.systemPrompt).not.toContain("Finish durable Todo editor")

    await recordFixture(assembly.factOwner, { type: "todo/write", version: 1, items: [] })
    await service.submit("s", "the list is cleared", new AbortController().signal)
    expect(requests.at(-1)!.systemPrompt).toContain('"todos":[]')
    expect(requests.at(-1)!.systemPrompt).not.toContain("Human corrected next step")
    await coordinator.flush("s")
    await service.close()
    await coordinator.close()

    coordinator = createSessionCoordinator(createJsonlBackend(store), { lock: { enabled: true } })
    service = createSessionService({ workspace: root, coordinator, sessionFor: createDurableSessionLoader(coordinator), model })
    await service.submit("s", "continue after restart", new AbortController().signal)
    expect(requests.at(-1)!.systemPrompt).toContain('"todos":[]')
    expect(requests.at(-1)!.systemPrompt).not.toContain("Human corrected next step")
    expect((await coordinator.snapshot!("s")).session.events.filter((event) => event.type === "todo/write")).toHaveLength(4)
  } finally { await service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

afterEach(() => vi.unstubAllGlobals())
