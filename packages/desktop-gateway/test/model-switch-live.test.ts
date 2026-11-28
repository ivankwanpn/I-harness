import { expect, it, vi } from "vitest"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isRpcSuccess, type RpcMessage } from "@i-harness/sdk"
import { createDesktopHost } from "../src/host.ts"

it("continues a mounted JSONL session after a live wire override and a durable profile change", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ih-model-switch-"))
  const settingsPath = join(workspace, "settings.json"), credentialsPath = join(workspace, "keys.json")
  const route = { protocol: "openai-responses", baseURL: "https://fixture.invalid", apiKeyEnv: "TEST_MODEL_SWITCH", models: [{ id: "m", contextWindow: 32000 }] }
  await writeFile(settingsPath, JSON.stringify({ autoTitle: false, codeMode: { mode: "off" }, compaction: { auto: false },
    llm: { defaultModel: { provider: "one", model: "m" }, providers: { one: route, two: route } } }))
  await writeFile(credentialsPath, JSON.stringify({ refs: { TEST_MODEL_SWITCH: "fixture" } }))
  const paths: string[] = [], frames: RpcMessage[] = []
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const { origin, pathname } = new URL(url)
    expect(origin).toBe(route.baseURL)
    const wire = JSON.parse(String(init.body))
    if (paths.length) expect(JSON.stringify(wire.messages ?? wire.input)).toContain("answer-" + paths.length)
    paths.push(pathname)
    const answer = "answer-" + paths.length
    const packets = pathname === "/v1/responses"
      ? [{ type: "response.output_text.delta", delta: answer }, { type: "response.completed", response: { status: "completed" } }]
      : [{ choices: [{ index: 0, delta: { content: answer }, finish_reason: "stop" }] }]
    return new Response(packets.map(p => "data: " + JSON.stringify(p) + "\n\n").join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  })
  const host = await createDesktopHost({ workspace, sessionDir: join(workspace, "sessions"), settingsPath, credentialsPath, sessionStore: "jsonl", onWrite: frame => frames.push(frame) })
  let nextId = 0
  const call = async (method: string, params: Record<string, unknown> = {}) => {
    const id = ++nextId
    await host.handleLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
    const reply = frames.find(frame => "id" in frame && frame.id === id)
    if (!reply || !isRpcSuccess(reply)) throw new Error(method + " " + JSON.stringify(reply))
    return reply.result
  }
  try {
    await call("initialize")
    const { sessionId } = await call("session/create") as { sessionId: string }
    await call("desktop/project/sync", { projects: [{ id: "test", name: "Fixture", roots: [workspace], primaryRoot: workspace }] })
    await call("desktop/session/project/bind", { sessionId, projectId: "test" })
    const select = (provider: string, protocol: string) => call("session/model/set", { sessionId, selection: { provider, model: "m", protocol } })
    const prompt = () => call("session/prompt", { sessionId, prompt: "Next step " + (paths.length + 1) })
    await select("one", "openai-responses")
    await prompt()
    const schedule = await call("desktop/schedule/create", { sessionId, command: { prompt: "Later", after_seconds: 600 } }) as { id: string }
    await expect(select("two", "openai-responses")).rejects.toThrow(/busy/)
    expect(await call("session/model/state", { sessionId })).toMatchObject({ providerId: "one" })
    await select("one", "openai-completions")
    await prompt()
    expect(await call("desktop/schedule/list", { sessionId })).toMatchObject({ schedules: [{ id: schedule.id }] })
    await call("desktop/schedule/delete", { sessionId, id: schedule.id })
    await select("two", "openai-responses")
    await prompt()
    expect(paths).toEqual(["/v1/responses", "/v1/chat/completions", "/v1/responses"])
    const history = await call("session/history", { sessionId, limit: 200, afterSeq: 0 }) as { events: { type: string }[] }
    expect(history.events.filter(e => e.type === "turn/end")).toHaveLength(3)
  } finally {
    try { await host.close() } finally { vi.unstubAllGlobals(); await rm(workspace, { recursive: true, force: true }) }
  }
}, 30_000)
