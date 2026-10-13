import { expect, it } from "vitest"
import { createContext } from "../../core-plugin/src/index.ts"
import { USER_DEFERRED_QUESTION, type QuestionProvider } from "../../interaction/src/index.ts"
import { encodeFrame, makeRequest, makeSuccess, type HarnessClient, type RpcMessage } from "@i-harness/sdk"
import type { SessionAssembly } from "../../session-executor/src/index.ts"
import { createDesktopRouter } from "@i-harness/desktop-gateway/src/router.ts"
import { createInteractionBridge, type PendingInteraction } from "@i-harness/desktop-gateway/src/interaction.ts"
import { dispatchDesktopRequest } from "../src/main/ipc.ts"

it.each(["main IPC", "ordinary RPC"])("defers through %s and the real router, then recovers the later answer once", async ingress => {
  const frames: RpcMessage[] = []
  let saved: PendingInteraction[] = []
  const recovered: string[] = []
  const interaction = createInteractionBridge(frame => frames.push(frame), {
    persistence: { read: () => saved, write: rows => { saved = structuredClone(rows) } },
    recover: async input => { recovered.push(input.text) },
  })
  const router = createDesktopRouter({
    handleLine: async () => encodeFrame(makeSuccess(1, {})), close: async () => {},
    clientInfo: () => undefined, onNotify: () => () => {},
  }, frame => frames.push(frame), { interaction })
  let id = 1
  const request = async (method: string, params: unknown) => {
    const current = ++id
    await router.handleLine(encodeFrame(makeRequest(current, method, params)))
    const reply = frames.find(frame => "id" in frame && frame.id === current)
    if (!reply || !("id" in reply)) throw new Error("missing RPC reply")
    if ("error" in reply) throw new Error(reply.error.message)
    return "result" in reply ? reply.result : undefined
  }
  const dependencies = {
    catalog: { get: () => ({ id: "w1", path: process.cwd(), label: "test" }) },
    runtimes: { get: async () => ({ client: { request } as HarnessClient }) },
  } as unknown as Parameters<typeof dispatchDesktopRequest>[1]
  const reply = (requestId: string, decision: { kind: "question"; deferred: true } | { kind: "question"; answer: string }) => ingress === "main IPC"
    ? dispatchDesktopRequest({ kind: "desktop/interaction/reply", workspaceId: "w1", sessionId: "s1", requestId, decision }, dependencies)
    : request("desktop/interaction/reply", { sessionId: "s1", requestId, decision })
  const owner = { sessionId: "s1", ctx: createContext() } as SessionAssembly
  interaction.attach(owner)
  const pending = owner.ctx.services.get<QuestionProvider>("questions/provider").ask({ id: "q1", prompt: "Which plan?" })
  // Always observe shutdown rejection if the wire regression fails before defer.
  void pending.catch(() => {})
  const requestId = interaction.pending()[0]!.requestId
  try {
    await router.handleLine(encodeFrame(makeRequest(1, "initialize", {})))
    await expect(reply(requestId, { kind: "question", deferred: true })).resolves.toEqual({ accepted: true })
    await expect(pending).resolves.toBe(USER_DEFERRED_QUESTION)
    expect(saved).toEqual([expect.objectContaining({ requestId, state: "interrupted" })])
    await reply(requestId, { kind: "question", deferred: true })
    expect(recovered).toEqual([])
    await reply(requestId, { kind: "question", answer: "My own approach" })
    expect(recovered).toHaveLength(1)
    expect(recovered[0]).toContain("My answer: My own approach")
    expect(saved).toEqual([])
    await expect(reply(requestId, { kind: "question", answer: "duplicate" })).rejects.toThrow(/settled/)
    expect(recovered).toHaveLength(1)
  } finally { interaction.close(); await router.close() }
})
