import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import { isRpcSuccess, type RpcMessage } from "@i-harness/sdk"
import { createDesktopHost } from "../src/host.ts"

it.each(["jsonl", "commit-log"] as const)("preserves cold queue receipts, cancellation and FIFO across restarts (%s)", async sessionStore => {
  const root = await mkdtemp(join(tmpdir(), "ih-queue-receipt-")), workspace = join(root, "project")
  await mkdir(workspace)
  const settingsPath = join(root, "settings.json"), credentialsPath = join(root, "keys.json")
  await writeFile(settingsPath, JSON.stringify({ autoTitle: false, codeMode: { mode: "off" }, compaction: { auto: false },
    llm: { defaultModel: { provider: "local", model: "fixture" }, providers: { local: { protocol: "openai-responses", baseURL: "https://fixture.invalid", apiKeyEnv: "IH_TEST_QUEUE", models: [{ id: "fixture", contextWindow: 32000, maxTokens: 2048 }] } } } }))
  await writeFile(credentialsPath, JSON.stringify({ refs: { IH_TEST_QUEUE: "fixture" } }))
  const sends: string[] = []
  const entered = Promise.withResolvers<void>()
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    expect(url).toBe("https://fixture.invalid/v1/responses")
    const body = JSON.parse(String(init.body))
    const text = body.input.findLast((item: { role?: string }) => item.role === "user")?.content
    sends.push(text)
    if (text === "hold turn") {
      entered.resolve()
      await new Promise((_, reject) => {
        const abort = () => reject(init.signal?.reason)
        if (init.signal?.aborted) abort()
        else init.signal?.addEventListener("abort", abort, { once: true })
      })
    }
    return new Response('data: {"type":"response.output_text.delta","delta":"done"}\n\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n')
  })
  const frames: RpcMessage[] = []
  const open = () => createDesktopHost({ workspace, sessionDir: join(root, "sessions"), settingsPath, credentialsPath, sessionStore, onWrite: frame => frames.push(frame) })
  let host: Awaited<ReturnType<typeof open>> | undefined, serial = 0
  async function call(method: string, params: Record<string, unknown> = {}) {
    const id = ++serial
    await host!.handleLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
    const frame = frames.find(f => "id" in f && f.id === id)
    if (!frame || !isRpcSuccess(frame)) throw Error(method + " " + JSON.stringify(frame))
    return frame.result
  }
  async function reopen() {
    await host?.close(); host = undefined
    host = await open(); await call("initialize")
    await call("desktop/project/sync", { projects: [{ id: "project", name: "Fixture", roots: [workspace], primaryRoot: workspace }] })
  }
  try {
    await reopen()
    const { sessionId } = await call("session/create") as { sessionId: string }
    await call("desktop/session/project/bind", { sessionId, projectId: "project" })
    const submit = (text: string, context?: string) => call("desktop/session/input/submit", { sessionId, text, context, delivery: "queue", clientToken: "receipt-for-" + text }) as Promise<{ accepted: boolean; inputId: string }>
    const queue = () => call("session/queue", { sessionId }) as Promise<{ items: { id: string; text: string; state: string }[] }>
    const idleAfter = async (count: number) => vi.waitFor(async () => {
      expect(sends).toHaveLength(count)
      expect(await call("session/status", { sessionId })).toMatchObject({ running: false })
    }, { timeout: 10000 })

    const original = await submit("completed original")
    await idleAfter(1)
    await submit("hold turn"); await entered.promise
    const toCancel = await submit("cancel this", "PRIVATE SUPPLEMENTAL CONTEXT")
    const toRetry = await submit("retry this")
    await submit("older pending one"); await submit("older pending two")
    await reopen()

    const cold = await queue()
    expect(cold.items.map(row => row.text)).toEqual(["cancel this", "retry this", "older pending one", "older pending two"])
    expect(JSON.stringify(cold)).not.toContain("PRIVATE SUPPLEMENTAL CONTEXT")
    expect(await call("session/status", { sessionId })).toEqual({ running: false, queued: 4 })
    expect(await call("session/queue/cancel", { sessionId: "unknown", id: toCancel.inputId })).toEqual({ cancelled: false })
    expect(await call("session/queue/cancel", { sessionId, id: toCancel.inputId })).toEqual({ cancelled: true })
    expect(await call("session/queue/cancel", { sessionId, id: toCancel.inputId })).toEqual({ cancelled: false })
    await reopen()
    expect((await queue()).items.map(row => row.text)).toEqual(["retry this", "older pending one", "older pending two"])
    expect(sends).toHaveLength(2)
    await expect(call("session/history", { sessionId: "unknown" })).rejects.toThrow(/-32602/)

    expect(await submit("completed original")).toEqual(original)
    expect(await submit("cancel this", "PRIVATE SUPPLEMENTAL CONTEXT")).toEqual(toCancel)
    expect(await call("desktop/session/input/state", { sessionId })).toMatchObject({ resumable: true })
    expect(await submit("retry this")).toEqual(toRetry)
    await idleAfter(3)
    expect((await queue()).items.map(row => row.text)).toEqual(["older pending one", "older pending two"])
    expect(sends).toEqual(["completed original", "hold turn", "retry this"])
    await submit("new turn")
    await idleAfter(6)
    expect(sends.slice(-3)).toEqual(["older pending one", "older pending two", "new turn"])
    expect((await queue()).items).toEqual([])
  } finally {
    try { await host?.close() } finally { vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }) }
  }
}, 45_000)
