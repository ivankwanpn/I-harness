import { expect, it } from "vitest"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fromJSONL, type SessionEvent } from "@i-harness/core-session"
import { isRpcFailure, isRpcSuccess } from "@i-harness/sdk"
import type { AgentSettingsState } from "../src/agent-settings.ts"
import { createRevokedPromptFixture } from "./helpers/revoked-prompt-fixture.ts"

// Managed sessions persist format-14 fact-journal lines, so the fixture's
// line-by-line JSON reader (written for the legacy per-event format) cannot see
// post-turn events; decode the journal instead.
const rawEvents = async (sessionDir: string, sessionId: string): Promise<SessionEvent[]> =>
  fromJSONL(await readFile(join(sessionDir, `${sessionId}.jsonl`), "utf8")).events

it("keeps removed-project execution denied and permits a confirmed move after the failed attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-revoked-prompt-move-")), f = await createRevokedPromptFixture(root)
  try {
    const sessionId = await f.removedSession()
    const refusal = await f.call("session/prompt", { sessionId, prompt: "Owned denied input" })
    expect(isRpcFailure(refusal)).toBe(true)
    if (!isRpcFailure(refusal)) throw new Error("Owned removed project executed")
    // 5e5db2de (executor): a revoked authority observed while preparing the
    // next step now surfaces as the instruction-context refusal
    // ('Observed instructions unavailable' / CONTEXT_INPUT_STALE) rather than
    // the earlier authority message; the turn still fails closed with zero
    // provider traffic. session/prompt wraps the service failure as
    // INTERNAL_ERROR with the service message (packages/sdk/src/server.ts:971-979).
    // The same contract is pinned in
    // packages/session-executor/test/revoked-prompt-cleanup.test.ts:20-22.
    expect(refusal.error.message).toMatch(/Observed instructions unavailable/i)
    expect(f.httpRequests).toHaveLength(0)
    expect(await f.success("desktop/session/project/state", { sessionId })).toEqual({ sessionId, projectId: f.projectId })
    const moved = await f.success<{ results: unknown[] }>("desktop/session/batch", { command: { action: "move", sessionIds: [sessionId], expectedOwners: { [sessionId]: f.projectId } } })
    expect(moved.results).toEqual([{ sessionId, ok: true, executionWorkspace: f.workspace }])
    const failedEvents = await rawEvents(f.sessionDir, sessionId)
    // The turn still starts and closes: the revoked authority surfaces inside the
    // awaited pre-step boundary as the instruction-context refusal, so the failed
    // step/turn are durable and no assistant message is produced
    // (packages/session-executor/test/revoked-prompt-cleanup.test.ts:10-29).
    expect(failedEvents.filter(event => event.type === "turn/start")).toHaveLength(1)
    expect(failedEvents.filter(event => event.type === "turn/end")).toHaveLength(1)
    expect(failedEvents.filter(event => event.type === "step/start")).toHaveLength(1)
    expect(failedEvents.filter(event => event.type === "step/end")).toHaveLength(1)
    expect(failedEvents.filter(event => event.type === "assistant/message")).toEqual([])
    await f.success("session/prompt", { sessionId, prompt: "Owned explicitly moved input" })
    expect(f.httpRequests).toHaveLength(1)
    expect((await rawEvents(f.sessionDir, sessionId)).some(event => event.type === "assistant/message" && event.text === "Owned allowed completion")).toBe(true)
  } finally { await f.close(); await rm(root, { recursive: true, force: true }) }
}, 15_000)

it("keeps revoked execution inspection empty and repeated settings reads stable without inventing sandbox markers", async () => {
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
      // Documented contract: execution inspection reports live assemblies only
      // (packages/session-executor/src/service.ts:1990 maps the `assemblies`
      // registry; the managed desktop runtime never enters it), and the desktop
      // settings surface states the same empty case ("目前沒有已選定執行後端的
      // 會話組裝", packages/desktop/src/renderer/settings/AgentSettings.tsx:139).
      // Revoked *live* inspection remains covered by
      // packages/session-executor/test/revoked-prompt-cleanup.test.ts:31-43.
      expect(state.executions).toEqual([])
    }
    // Repeated settings reads must not alternate live sandbox markers: the one
    // construction-time mode recorded for this session stays authoritative.
    expect((await rawEvents(f.sessionDir, sessionId)).filter(event => event.type === "sandbox/mode").map(event => event.mode)).toEqual(["workspace-write"])
    expect(f.httpRequests).toHaveLength(0)
  } finally { await f.close(); await rm(root, { recursive: true, force: true }) }
}, 15_000)
