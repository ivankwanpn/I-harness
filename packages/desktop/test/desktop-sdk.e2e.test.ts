import { afterEach, describe, expect, it } from "vitest"
import { createServer, type Server, type ServerResponse } from "node:http"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { RpcNotification } from "@i-harness/sdk"
import { createWorkspaceRuntimeManager, type WorkspaceRuntimeManager } from "../src/main/sdk-runtime.ts"
import type { WorkspaceEntry } from "../src/main/workspaces.ts"
import { applyHistory, emptyEventWindow, type EventWindow } from "../src/renderer/session/event-window.ts"
import { projectTimeline } from "../src/renderer/session/project.ts"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface Fixture {
  manager: WorkspaceRuntimeManager
  workspace: WorkspaceEntry
  outsidePath: string
  close(): Promise<void>
}

/** Loopback OpenAI-completions fixture: instant text, or a stream that never
 * finishes so the turn can be cancelled mid-flight. */
async function startFixture(mode: "text" | "slow" | "approval", outsidePath: string): Promise<{
  close(): Promise<void>
  baseURL: string
  slowResponses: ServerResponse[]
  providerCalls(): number
}> {
  let calls = 0
  const slowResponses: ServerResponse[] = []
  const server: Server = createServer((request, response) => {
    request.resume()
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end()
      return
    }
    calls += 1
    response.writeHead(200, { "content-type": "text/event-stream" })
    if (mode === "text") {
      response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "fixture answer" } }] })}\n\ndata: [DONE]\n\n`)
      return
    }
    if (mode === "approval") {
      const delta = calls === 1
        ? {
            tool_calls: [{
              index: 0,
              id: "call_write",
              function: { name: "write", arguments: JSON.stringify({ path: outsidePath, text: "no" }) },
            }],
          }
        : { content: "denied" }
      response.end(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`)
      return
    }
    response.write(": keep-alive\n\n")
    slowResponses.push(response)
    response.on("error", () => {})
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("fixture provider did not listen")
  return {
    baseURL: `http://127.0.0.1:${address.port}`,
    slowResponses,
    providerCalls: () => calls,
    close: () => new Promise<void>((resolve, reject) => {
      for (const response of slowResponses) response.destroy()
      server.closeAllConnections()
      server.close((error) => error === undefined ? resolve() : reject(error))
    }),
  }
}

async function setup(mode: "text" | "slow" | "approval"): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), `ih-desktop-e2e-${mode}-`))
  roots.push(root)
  const workspaceDir = join(root, "workspace")
  const configDir = join(root, "config")
  mkdirSync(workspaceDir)
  mkdirSync(configDir)
  const outsidePath = join(root, "outside.txt")
  const provider = await startFixture(mode, outsidePath)
  writeFileSync(join(configDir, "settings.json"), JSON.stringify({
    sandboxMode: "workspace-write",
    llm: {
      providers: {
        fixture: {
          protocol: "openai-completions",
          baseURL: provider.baseURL,
          apiKeyEnv: "FIXTURE_API_KEY",
          models: [{ id: "fixture-model" }],
        },
      },
      defaultModel: { provider: "fixture", model: "fixture-model" },
    },
  }), "utf8")
  writeFileSync(join(configDir, "credentials.json"), JSON.stringify({ refs: { FIXTURE_API_KEY: "fixture-key" } }), "utf8")
  const previous = process.env.IH_CONFIG_DIR
  process.env.IH_CONFIG_DIR = configDir
  const manager = createWorkspaceRuntimeManager({ sessionsRoot: join(root, "sessions") })
  return {
    manager,
    workspace: { id: `ws-${mode}`, path: workspaceDir, label: "workspace" },
    outsidePath,
    async close() {
      await manager.close()
      await provider.close()
      if (previous === undefined) delete process.env.IH_CONFIG_DIR
      else process.env.IH_CONFIG_DIR = previous
    },
  }
}

function collect(manager: WorkspaceRuntimeManager): {
  notifications: RpcNotification[]
  disconnected: () => number
} {
  const notifications: RpcNotification[] = []
  let disconnects = 0
  manager.onEvent((event) => {
    if (event.kind === "sdk/disconnected") disconnects += 1
  })
  return { notifications, disconnected: () => disconnects }
}

describe("Desktop SDK reconnect and cancel against the real gateway", () => {
  it("keeps exactly one durable assistant row across a child restart", async () => {
    const fixture = await setup("text")
    try {
      const runtime = await fixture.manager.get(fixture.workspace)
      const sessionId = (await runtime.client.createSession()).sessionId
      await runtime.client.request("session/prompt", { sessionId, prompt: "say hi" }, 30_000)

      let windowState: EventWindow = emptyEventWindow()
      windowState = applyHistory(windowState, await runtime.client.history(sessionId, {
        afterSeq: windowState.cursor, limit: 1000,
      }))
      const before = projectTimeline(windowState.events)
        .filter((row) => row.kind === "message" && row.role === "assistant")
      expect(before).toHaveLength(1)
      expect(before[0]).toMatchObject({ text: expect.stringContaining("fixture answer") })

      const events = collect(fixture.manager)
      await runtime.client.close()
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(events.disconnected()).toBe(1)

      const restarted = await fixture.manager.get(fixture.workspace)
      expect(restarted.client).not.toBe(runtime.client)
      windowState = applyHistory(windowState, await restarted.client.history(sessionId, {
        afterSeq: windowState.cursor, limit: 1000,
      }))

      const after = projectTimeline(windowState.events)
        .filter((row) => row.kind === "message" && row.role === "assistant")
      expect(after).toHaveLength(1)
      expect(windowState.cursor).toBeGreaterThanOrEqual(1)
    } finally {
      await fixture.close()
    }
  }, 60_000)

  it("cancels a running prompt without fabricating a success row", async () => {
    const fixture = await setup("slow")
    try {
      const runtime = await fixture.manager.get(fixture.workspace)
      const sessionId = (await runtime.client.createSession()).sessionId
      const pending = runtime.client.request("session/prompt", { sessionId, prompt: "long turn" }, 60_000)
      const settled = pending.then(() => "resolved" as const, () => "rejected" as const)

      // Wait until the host itself says the lane is busy, then cancel.
      await new Promise((resolve) => setTimeout(resolve, 1500))
      const cancel = await runtime.client.cancel(sessionId)
      expect(cancel).toEqual({ cancelled: true })
      expect(await settled).toBe("rejected")

      const page = await runtime.client.history(sessionId, { afterSeq: 0, limit: 1000 })
      const rows = projectTimeline(page.events)
      expect(rows.filter((row) => row.kind === "message" && row.role === "assistant")).toHaveLength(0)
    } finally {
      await fixture.close()
    }
  }, 60_000)

  it("denies a tool request through the interaction wire and keeps the write off disk", async () => {
    const fixture = await setup("approval")
    try {
      const runtime = await fixture.manager.get(fixture.workspace)
      const sessionId = (await runtime.client.createSession()).sessionId
      const seen: unknown[] = []
      fixture.manager.onEvent((event) => {
        if (event.kind === "sdk/notification" && event.method === "desktop/interaction/request") seen.push(event.params)
      })

      const prompt = runtime.client.request("session/prompt", { sessionId, prompt: "write outside" }, 60_000)
      const settled = prompt.then(() => "resolved" as const, () => "rejected" as const)
      const deadline = Date.now() + 20_000
      while (seen.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      expect(seen).toHaveLength(1)

      const listed = await runtime.client.request("desktop/interaction/pending", { sessionId }) as Array<{ requestId: string }>
      expect(listed).toHaveLength(1)
      await runtime.client.request("desktop/interaction/reply", {
        requestId: listed[0]!.requestId,
        sessionId,
        decision: { kind: "approval", approved: false },
      })

      expect(await settled).toBe("rejected")
      expect(existsSync(fixture.outsidePath)).toBe(false)
      expect(await runtime.client.request("desktop/interaction/pending", { sessionId })).toEqual([])
    } finally {
      await fixture.close()
    }
  }, 60_000)
})
