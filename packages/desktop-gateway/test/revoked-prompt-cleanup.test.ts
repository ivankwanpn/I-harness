import { expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isRpcFailure, isRpcSuccess } from "@i-harness/sdk"
import type { AgentSettingsState } from "../src/agent-settings.ts"
import { createRevokedPromptFixture } from "./helpers/revoked-prompt-fixture.ts"

it("keeps removed-project execution denied and permits a confirmed move after the failed attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-revoked-prompt-move-")), f = await createRevokedPromptFixture(root)
  try {
    const sessionId = await f.removedSession()
    const refusal = await f.call("session/prompt", { sessionId, prompt: "Owned denied input" })
    expect(isRpcFailure(refusal)).toBe(true)
    if (!isRpcFailure(refusal)) throw new Error("Owned removed project executed")
    expect(refusal.error.message).toMatch(/authority revoked|catalog entry missing/i)
    expect(f.httpRequests).toHaveLength(0)
    expect(await f.success("desktop/session/project/state", { sessionId })).toEqual({ sessionId, projectId: f.projectId })
    const moved = await f.success<{ results: unknown[] }>("desktop/session/batch", { command: { action: "move", sessionIds: [sessionId], expectedOwners: { [sessionId]: f.projectId } } })
    expect(moved.results).toEqual([{ sessionId, ok: true, executionWorkspace: f.workspace }])
    const failedEvents = await f.rawEvents(sessionId)
    expect(failedEvents.filter(event => event.type === "turn/start")).toHaveLength(1)
    expect(failedEvents.filter(event => event.type === "turn/end")).toHaveLength(1)
    expect(failedEvents.filter(event => event.type === "step/start")).toHaveLength(1)
    expect(failedEvents.filter(event => event.type === "step/end")).toHaveLength(1)
    expect(failedEvents.some(event => event.type === "assistant/message")).toBe(false)
    await f.success("session/prompt", { sessionId, prompt: "Owned explicitly moved input" })
    expect(f.httpRequests).toHaveLength(1)
    expect((await f.rawEvents(sessionId)).some(event => event.type === "assistant/message" && event.text === "Owned allowed completion")).toBe(true)
  } finally { await f.close(); await rm(root, { recursive: true, force: true }) }
}, 15_000)

it("reports revoked execution as unavailable without alternating live sandbox markers on repeated settings reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-revoked-prompt-policy-")), f = await createRevokedPromptFixture(root)
  try {
    const sessionId = await f.removedSession()
    expect(isRpcFailure(await f.call("session/prompt", { sessionId, prompt: "Owned denied input" }))).toBe(true)
    const replies = []
    for (let i = 0; i < 3; i++) replies.push(await f.call("desktop/agent-settings/state"))
    await f.close()
    for (const reply of replies) {
      expect(isRpcSuccess(reply)).toBe(true)
      if (!isRpcSuccess(reply)) continue
      const state = reply.result as AgentSettingsState
      expect(state).toMatchObject({ saved: { sandboxMode: "workspace-write" }, effective: { sandboxMode: "workspace-write" }, restartRequired: false })
      expect(state.executions).toEqual([{ sessionId, status: expect.objectContaining({ availability: "unavailable", detail: expect.stringMatching(/authority revoked|catalog entry missing/i) }) }])
    }
    expect((await f.rawEvents(sessionId)).filter(event => event.type === "sandbox/mode").map(event => event.mode)).toEqual(["workspace-write"])
    expect(f.httpRequests).toHaveLength(0)
  } finally { await f.close(); await rm(root, { recursive: true, force: true }) }
}, 15_000)
