import { expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AuthorityState } from "@i-harness/sandbox"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { createDurableSessionLoader, createSessionService } from "../src/index.ts"

it("closes a durable turn when its authority is revoked inside the awaited pre-step boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-late-revoked-prompt-")), coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true, lockRoot: root } })
  await coordinator.create({ sessionId: "owned" })
  let authority: AuthorityState = { kind: "unbound", revision: "1", workspaceRoot: root }, modelCalls = 0
  const service = createSessionService({ workspace: root, coordinator, sessionFor: createDurableSessionLoader(coordinator), sandbox: "workspace-write", executionAuthority: () => authority,
    model: { async *stream() { modelCalls++; yield { type: "end" } } },
  })
  try {
    const assembly = await service.assemblyFor("owned")
    assembly.ctx.on("agent/pre-step", async () => { await Promise.resolve(); authority = { kind: "revoked", revision: "2", reason: "Owned project removed during pre-step" } })
    await expect(service.submit("owned", "Owned late denial", new AbortController().signal)).rejects.toThrow(/authority revoked/i)
    expect(modelCalls).toBe(0)
    const events = (await coordinator.snapshot!("owned")).session.events
    expect(events.slice(-3).map(event => event.type)).toEqual(["step/failed", "step/end", "turn/end"])
    expect(events.some(event => event.type === "assistant/message")).toBe(false)
    expect(service.queueState("owned")).toMatchObject({ queued: 0, running: false })
  } finally { await service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it.each(["revoked", "unavailable"] as const)("keeps %s execution inspection observational while tools remain denied", async kind => {
  const root = await mkdtemp(join(tmpdir(), "ih-revoked-execution-state-"))
  let authority: AuthorityState = { kind: "unbound", revision: "1", workspaceRoot: root }
  const service = createSessionService({ workspace: root, sandbox: "workspace-write", executionAuthority: () => authority, modelPolicy: "test-mock" })
  try {
    const assembly = await service.assemblyFor("owned")
    authority = { kind, revision: "2", reason: "Owned scope denied" }
    const states = await service.executionBackendStatus()
    expect(states).toEqual([{ sessionId: "owned", status: expect.objectContaining({ authority: kind, availability: "unavailable", detail: expect.stringContaining("Owned scope denied"), windowsSandboxBackend: "legacy" }) }])
    expect(states[0]!.status).not.toHaveProperty("assurance")
    expect(states[0]!.status).not.toHaveProperty("features")
    await expect(assembly.tools.execute({ name: "write", args: { path: "must-not-exist", text: "denied" } })).rejects.toThrow(/revoked|unavailable|denied/i)
  } finally { await service.close(); await rm(root, { recursive: true, force: true }) }
})
