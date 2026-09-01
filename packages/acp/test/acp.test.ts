// R-C7: @i-harness/acp — ACP v1 automation subset server over the official
// @agentclientprotocol/sdk. Tests drive the server through the SDK's own
// client app (in-process, official client code) — initialize fields,
// session/new|prompt|list|resume|close, cancel notification no-op, and the
// v0 permission face (autoApprove). One end-to-end test spawns the real CLI
// (`i-harness acp`) over stdio NDJSON.
import { describe, expect, it } from "vitest"
import { client } from "@agentclientprotocol/sdk"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { fileURLToPath } from "node:url"
import { createSessionService, type SessionService } from "@i-harness/session-executor"
import { createAcpServer, ACP_SERVER_NAME, ACP_PROTOCOL_VERSION } from "../src/index.ts"

async function makeService(): Promise<{ service: SessionService; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "ih-acp-"))
  const service = createSessionService({
    workspace: dir,
    approveAll: true,
    mockScript: [{ role: "assistant", text: "hello from the mock" }],
  })
  return { service, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

/** initialize helper through the typed client context. */
async function init(ctx: { request: (method: string, params: unknown) => Promise<unknown> }) {
  return ctx.request("initialize", {
    protocolVersion: ACP_PROTOCOL_VERSION,
    clientInfo: { name: "vitest-client", version: "0.0.0", title: "vitest" },
  }) as Promise<{
    protocolVersion: number
    agentInfo?: { name: string; version: string } | null
    agentCapabilities?: { sessionCapabilities?: { list?: unknown; close?: unknown; resume?: unknown } }
  }>
}

describe("createAcpServer", () => {
  it("initialize returns the ACP v1 server info (field-level)", async () => {
    const { service } = await makeService()
    const server = createAcpServer({ service })
    const app = client({ name: "vitest-client" })
    await app.connectWith(server, async (ctx) => {
      const res = await init(ctx)
      expect(res.protocolVersion).toBe(ACP_PROTOCOL_VERSION)
      expect(res.agentInfo?.name).toBe(ACP_SERVER_NAME)
      expect(res.agentInfo?.version).toBe("0.1.0")
      expect(res.agentCapabilities?.sessionCapabilities?.list).toBeDefined()
      expect(res.agentCapabilities?.sessionCapabilities?.close).toBeDefined()
      expect(res.agentCapabilities?.sessionCapabilities?.resume).toBeDefined()
    })
    await service.close()
  })

  it("session/new → session/prompt (submit admission) → stopReason end_turn", async () => {
    const { service } = await makeService()
    const server = createAcpServer({ service })
    const app = client({ name: "vitest-client" })
    await app.connectWith(server, async (ctx) => {
      await init(ctx)
      const session = await ctx.buildSession(join(tmpdir(), "ih-acp-cwd")).start()
      expect(session.sessionId).toBeTruthy()
      const promptRes = await session.prompt("hello")
      expect(promptRes.stopReason).toBe("end_turn")
    })
    await service.close()
  })

  it("session/list + resume + close round-trip", async () => {
    const { service } = await makeService()
    const server = createAcpServer({ service })
    const app = client({ name: "vitest-client" })
    await app.connectWith(server, async (ctx) => {
      await init(ctx)
      const session = await ctx.buildSession(join(tmpdir(), "ih-acp-cwd")).start()
      const list = (await ctx.request("session/list", {})) as { sessions: Array<{ sessionId: string }> }
      expect(list.sessions.map((s) => s.sessionId)).toContain(session.sessionId)
      const resume = await ctx.request("session/resume", {
        sessionId: session.sessionId,
        cwd: join(tmpdir(), "ih-acp-cwd"),
      })
      expect(resume).toEqual({})
      const close = await ctx.request("session/close", { sessionId: session.sessionId })
      expect(close).toEqual({})
    })
    await service.close()
  })

  it("session/cancel notification is a no-op when idle; prompts still run", async () => {
    const { service } = await makeService()
    const server = createAcpServer({ service })
    const app = client({ name: "vitest-client" })
    await app.connectWith(server, async (ctx) => {
      await init(ctx)
      const session = await ctx.buildSession(join(tmpdir(), "ih-acp-cwd")).start()
      await ctx.notify("session/cancel", { sessionId: session.sessionId })
      const promptRes = await session.prompt("hello after cancel")
      expect(promptRes.stopReason).toBe("end_turn")
    })
    await service.close()
  })

  it("autoApprove:false refuses prompts (v0 permission face = allow off, no round-trip)", async () => {
    const { service } = await makeService()
    const server = createAcpServer({ service, autoApprove: false })
    const app = client({ name: "vitest-client" })
    await app.connectWith(
      server,
      async (ctx) => {
        await init(ctx)
        const session = await ctx.buildSession(join(tmpdir(), "ih-acp-cwd")).start()
        await expect(session.prompt("must not run")).rejects.toThrow()
      },
    )
    await service.close()
  })

  it("session/prompt on an unknown session fails closed", async () => {
    const { service } = await makeService()
    const server = createAcpServer({ service })
    const app = client({ name: "vitest-client" })
    await app.connectWith(
      server,
      async (ctx) => {
        await init(ctx)
        await expect(
          ctx.request("session/prompt", {
            sessionId: "missing-1",
            prompt: [{ type: "text", text: "hi" }],
          }),
        ).rejects.toThrow()
      },
    )
    await service.close()
  })
})

/** NDJSON stdio driver for the spawned CLI subprocess. */
function drive(child: ChildProcessWithoutNullStreams): {
  send: (message: unknown) => void
  waitFor: (predicate: (msg: Record<string, unknown>) => boolean, label: string) => Promise<Record<string, unknown>>
  stderrText: () => string
} {
  let buffer = ""
  const messages: Record<string, unknown>[] = []
  let stderr = ""
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8")
    let idx: number
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (line === "") continue
      try {
        messages.push(JSON.parse(line) as Record<string, unknown>)
      } catch {
        // non-JSON noise on stdout would be a protocol break; ignored here
      }
    }
  })
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8")
  })
  return {
    send: (message) => child.stdin.write(`${JSON.stringify(message)}\n`),
    waitFor: (predicate, label) =>
      new Promise((resolve, reject) => {
        const start = Date.now()
        const poll = (): void => {
          const found = messages.find(predicate)
          if (found !== undefined) return resolve(found)
          if (Date.now() - start > 15000) {
            return reject(new Error(`timed out waiting for ${label}; stderr: ${stderr.slice(0, 2000)}`))
          }
          setTimeout(poll, 20)
        }
        poll()
      }),
    stderrText: () => stderr,
  }
}

describe("i-harness acp (CLI stdio)", () => {
  it("initialize → new → prompt → list → close over stdio NDJSON", async () => {
    const repoRoot = fileURLToPath(new URL("../../..", import.meta.url))
    const cliEntry = fileURLToPath(new URL("../../../apps/cli/src/index.ts", import.meta.url))
    const cwd = await mkdtemp(join(tmpdir(), "ih-acp-cli-"))
    const child = spawn(process.execPath, ["--import", "tsx", cliEntry, "acp"], {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
    })
    const io = drive(child)
    try {
      io.send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: ACP_PROTOCOL_VERSION, clientInfo: { name: "vitest-client", version: "0.0.0" } },
      })
      const initRes = await io.waitFor(
        (m) => m.id === 1 && typeof m.result === "object" && m.result !== null,
        "initialize response",
      )
      expect((initRes.result as { protocolVersion?: number }).protocolVersion).toBe(ACP_PROTOCOL_VERSION)

      io.send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd, mcpServers: [] } })
      const newRes = await io.waitFor((m) => m.id === 2, "session/new response")
      const sessionId = (newRes.result as { sessionId: string }).sessionId
      expect(sessionId).toBeTruthy()

      io.send({
        jsonrpc: "2.0",
        id: 3,
        method: "session/prompt",
        params: { sessionId, prompt: [{ type: "text", text: "hello" }] },
      })
      const promptRes = await io.waitFor((m) => m.id === 3, "session/prompt response")
      expect((promptRes.result as { stopReason?: string }).stopReason).toBe("end_turn")

      io.send({ jsonrpc: "2.0", id: 4, method: "session/list", params: {} })
      const listRes = await io.waitFor((m) => m.id === 4, "session/list response")
      expect((listRes.result as { sessions: Array<{ sessionId: string }> }).sessions.map((s) => s.sessionId)).toContain(
        sessionId,
      )

      io.send({ jsonrpc: "2.0", id: 5, method: "session/close", params: { sessionId } })
      await io.waitFor((m) => m.id === 5, "session/close response")

      child.stdin.end()
      const code = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("CLI did not exit; stderr: " + io.stderrText())), 15000)
        child.on("exit", (exitCode) => {
          clearTimeout(timer)
          resolve(exitCode ?? -1)
        })
      })
      expect(code).toBe(0)
    } finally {
      await rm(cwd, { recursive: true, force: true }).catch(() => {})
      if (child.exitCode === null) child.kill()
    }
  }, 30000)
})
