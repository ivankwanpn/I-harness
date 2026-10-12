import { expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSessionCoordinator } from "../../session-persistence/src/index.ts"
import { createJsonlBackend } from "../../session-persistence-jsonl/src/index.ts"
import { subscribe } from "../../core-session/src/index.ts"
import { createDurableSessionLoader, createSessionService } from "../../session-executor/src/index.ts"
import { createDesktopWorkflow } from "../../desktop-gateway/src/workflow.ts"
import { createRuntimeDiagnostics } from "../src/main/runtime-diagnostics.ts"
import type { DesktopEvent } from "../src/shared/bridge.ts"

function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

it("keeps a newer physical attempt live while an older Goal saves its failure recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-feedback-settlement-"))
  const recovery = gate(), recoveryEntered = gate(), secondEntered = gate(), secondProgress = gate(), workflowDone = gate()
  const coordinator = createSessionCoordinator(createJsonlBackend(join(root, "sessions")))
  await coordinator.create({ sessionId: "s" })
  const put = coordinator.putDocument.bind(coordinator)
  coordinator.putDocument = async (key, value) => {
    if (key.startsWith("desktop-goal-")) { recoveryEntered.release(); await recovery.promise }
    return put(key, value)
  }
  const diagnostics = createRuntimeDiagnostics(join(root, "diagnostics"))
  const phases: string[] = []
  diagnostics.onActivity(value => phases.push(value.activity.phase))
  const send = (event: DesktopEvent) => diagnostics.observe(event)
  let calls = 0
  const service = createSessionService({ workspace: root, coordinator, sessionFor: createDurableSessionLoader(coordinator), model: {
    async *stream() {
      if (++calls === 1) throw new Error("first goal failure")
      const activity = { requestId: "physical-second", phase: "connecting" as const, startedAt: Date.now(), waitingFor: "first-response" as const }
      yield { type: "activity", activity }
      secondEntered.release(); await secondProgress.promise
      yield { type: "activity", activity: { ...activity, phase: "quiet" } }
      yield { type: "text/chunk", text: "new turn done" }
      yield { type: "end" }
    },
  } })
  service.onAssembly(assembly => subscribe(assembly.session, event => send({ kind: "sdk/notification", workspaceId: "w", method: "session/event", params: { sessionId: "s", event } })))
  service.onExecutionState!(state => send({ kind: "sdk/notification", workspaceId: "w", method: "session/execution-state", params: state }))
  const workflow = createDesktopWorkflow(coordinator, service, { onRunningChanged(sessionId, running, error) {
    send({ kind: "sdk/notification", workspaceId: "w", method: "session/status", params: { sessionId, status: running ? "queued" : error ? "failed" : "completed", error } })
    if (!running) workflowDone.release()
  } })
  let next: Promise<unknown> | undefined
  try {
    await workflow.mutate("s", { action: "goal", operation: "create", request: { objective: "fixture" }, start: true })
    await recoveryEntered.promise
    next = service.submit("s", "second turn", new AbortController().signal)
    await secondEntered.promise
    recovery.release(); await workflowDone.promise
    expect(service.queueState("s")).toEqual({ running: true, queued: 0 })
    secondProgress.release(); await next
    expect(phases).toEqual(["connecting", "quiet", "settled"])
    expect((await diagnostics.list()).entries.filter(entry => entry.kind === "session/error")).toMatchObject([{ code: "model_error" }])
  } finally {
    recovery.release(); secondProgress.release()
    await next?.catch(() => {})
    await workflow.close(); await service.close(); await coordinator.close(); await diagnostics.flush()
    await rm(root, { recursive: true, force: true })
  }
})
