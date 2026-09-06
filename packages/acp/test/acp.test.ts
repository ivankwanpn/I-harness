// R-C7: @i-harness/acp — ACP v1 automation subset server over the official
// @agentclientprotocol/sdk. Tests drive the server through the SDK's own
// client app (in-process, official client code) — initialize fields,
// session/new|prompt|list|resume|close, cancel notification no-op, and the
// v0 permission face (autoApprove). One end-to-end test spawns the real CLI
// (`i-harness acp`) over stdio NDJSON.
import { describe, expect, it, vi } from "vitest"
import { client } from "@agentclientprotocol/sdk"
import type { SessionCoordinator } from "@i-harness/session-persistence"
import { mkdtemp, readFile, rm } from "node:fs/promises"
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

  it("adopts an existing durable session before ACP resume", async () => {
    const { service } = await makeService()
    const adoptOwnership = vi.fn(async (_sessionId: string) => {})
    const coordinator = {
      profile: vi.fn(async (_sessionId: string) => ({
        meta: { formatVersion: 1, sessionId: "existing", createdAt: new Date().toISOString() },
        blank: false,
      })),
      adoptOwnership,
    } as unknown as SessionCoordinator
    const server = createAcpServer({ service, coordinator })
    const app = client({ name: "vitest-client" })
    await app.connectWith(server, async (ctx) => {
      await init(ctx)
      await ctx.request("session/resume", { sessionId: "existing", cwd: join(tmpdir(), "ih-acp-cwd") })
    })
    expect(adoptOwnership).toHaveBeenCalledTimes(1)
    expect(adoptOwnership).toHaveBeenCalledWith("existing")
    await service.close()
  })

  it("session/close disposes, flushes, and releases one durable session", async () => {
    const closeSession = vi.fn(async (_sessionId: string) => {})
    const service = {
      submit: vi.fn(async () => {}),
      assemblyFor: vi.fn(async () => { throw new Error("unused") }),
      liveSession: () => undefined,
      hasAssembly: () => false,
      queueState: () => ({ running: false, queued: 0 }),
      onAssembly: () => () => {},
      closeSession,
      close: async () => {},
    } as SessionService
    const flush = vi.fn(async (_sessionId: string) => {})
    const releaseOwnership = vi.fn(async (_sessionId: string) => {})
    const coordinator = {
      profile: vi.fn(async (_sessionId: string) => ({
        meta: { formatVersion: 1, sessionId: "existing", createdAt: new Date().toISOString() },
        blank: false,
      })),
      adoptOwnership: vi.fn(async (_sessionId: string) => {}),
      flush,
      releaseOwnership,
    } as unknown as SessionCoordinator
    const server = createAcpServer({ service, coordinator })
    const app = client({ name: "vitest-client" })

    await app.connectWith(server, async (ctx) => {
      await init(ctx)
      await ctx.request("session/resume", { sessionId: "existing", cwd: join(tmpdir(), "ih-acp-cwd") })
      await ctx.request("session/close", { sessionId: "existing" })
    })

    expect(closeSession).toHaveBeenCalledWith("existing")
    expect(flush).toHaveBeenCalledWith("existing")
    expect(releaseOwnership).toHaveBeenCalledWith("existing")
  })

  it("durable session/prompt stays closed until explicit session/resume", async () => {
    const service = {
      submit: vi.fn(async () => {}),
      assemblyFor: vi.fn(async () => { throw new Error("unused") }),
      liveSession: () => undefined,
      hasAssembly: () => false,
      queueState: () => ({ running: false, queued: 0 }),
      onAssembly: () => () => {},
      closeSession: vi.fn(async () => {}),
      close: async () => {},
    } as SessionService
    const coordinator = {
      profile: vi.fn(async (_sessionId: string) => ({
        meta: { formatVersion: 1, sessionId: "existing", createdAt: new Date().toISOString() },
        blank: false,
      })),
      adoptOwnership: vi.fn(async (_sessionId: string) => {}),
      flush: vi.fn(async (_sessionId: string) => {}),
      releaseOwnership: vi.fn(async (_sessionId: string) => {}),
    } as unknown as SessionCoordinator
    const server = createAcpServer({ service, coordinator })
    const app = client({ name: "vitest-client" })

    await app.connectWith(server, async (ctx) => {
      await init(ctx)
      await ctx.request("session/resume", { sessionId: "existing", cwd: join(tmpdir(), "ih-acp-cwd") })
      await ctx.request("session/close", { sessionId: "existing" })
      await expect(ctx.request("session/prompt", {
        sessionId: "existing",
        prompt: [{ type: "text", text: "must resume" }],
      })).rejects.toThrow()

      await ctx.request("session/resume", { sessionId: "existing", cwd: join(tmpdir(), "ih-acp-cwd") })
      await expect(ctx.request("session/prompt", {
        sessionId: "existing",
        prompt: [{ type: "text", text: "after resume" }],
      })).resolves.toEqual({ stopReason: "end_turn" })
    })

    expect(service.submit).toHaveBeenCalledTimes(1)
  })

  it("session/close preserves durable ownership and active state when flush fails", async () => {
    const service = {
      submit: vi.fn(async () => {}),
      assemblyFor: vi.fn(async () => { throw new Error("unused") }),
      liveSession: () => undefined,
      hasAssembly: () => false,
      queueState: () => ({ running: false, queued: 0 }),
      onAssembly: () => () => {},
      closeSession: vi.fn(async () => {}),
      close: async () => {},
    } as SessionService
    let flushAttempts = 0
    const flush = vi.fn(async (_sessionId: string) => {
      flushAttempts += 1
      if (flushAttempts === 1) throw new Error("transient flush failure")
    })
    const releaseOwnership = vi.fn(async (_sessionId: string) => {})
    const profile = vi.fn(async (_sessionId: string) => ({
      meta: { formatVersion: 1, sessionId: "existing", createdAt: new Date().toISOString() },
      blank: false,
    }))
    const coordinator = {
      profile,
      adoptOwnership: vi.fn(async (_sessionId: string) => {}),
      flush,
      releaseOwnership,
    } as unknown as SessionCoordinator
    const server = createAcpServer({ service, coordinator })
    const app = client({ name: "vitest-client" })

    await app.connectWith(server, async (ctx) => {
      await init(ctx)
      await ctx.request("session/resume", { sessionId: "existing", cwd: join(tmpdir(), "ih-acp-cwd") })

      await expect(ctx.request("session/close", { sessionId: "existing" })).rejects.toThrow()
      expect(releaseOwnership).not.toHaveBeenCalled()
      await expect(ctx.request("session/prompt", {
        sessionId: "existing",
        prompt: [{ type: "text", text: "must stay closed" }],
      })).rejects.toThrow()
      expect(service.submit).not.toHaveBeenCalled()

      profile.mockRejectedValue(new Error("durable lookup unavailable"))
      await expect(ctx.request("session/close", { sessionId: "existing" })).resolves.toEqual({})
      expect(releaseOwnership).toHaveBeenCalledTimes(1)
      await expect(ctx.request("session/prompt", {
        sessionId: "existing",
        prompt: [{ type: "text", text: "closed" }],
      })).rejects.toThrow()
    })

    expect(flush).toHaveBeenCalledTimes(2)
    expect(service.submit).not.toHaveBeenCalled()
  })

  it("session/close removes an in-memory session from the known set", async () => {
    const { service } = await makeService()
    const server = createAcpServer({ service })
    const app = client({ name: "vitest-client" })
    await app.connectWith(server, async (ctx) => {
      await init(ctx)
      const session = await ctx.buildSession(join(tmpdir(), "ih-acp-cwd")).start()
      await ctx.request("session/close", { sessionId: session.sessionId })
      await expect(session.prompt("must not reopen implicitly")).rejects.toThrow()
    })
    await service.close()
  })

  it("session/cancel aborts a second overlapping prompt after the first settles", async () => {
    let firstStarted!: () => void
    const firstStartedP = new Promise<void>((resolve) => { firstStarted = resolve })
    let secondStarted!: () => void
    const secondStartedP = new Promise<void>((resolve) => { secondStarted = resolve })
    let finishFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { finishFirst = resolve })
    let finishSecond!: () => void
    let secondSignal: AbortSignal | undefined
    const service = {
      submit: vi.fn(async (_sessionId: string, prompt: string, signal: AbortSignal) => {
        if (prompt === "first") {
          firstStarted()
          await firstGate
          return
        }
        secondSignal = signal
        secondStarted()
        await new Promise<void>((resolve, reject) => {
          finishSecond = resolve
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
        })
      }),
      assemblyFor: vi.fn(async () => { throw new Error("unused") }),
      liveSession: () => undefined,
      hasAssembly: () => false,
      queueState: () => ({ running: false, queued: 0 }),
      onAssembly: () => () => {},
      closeSession: vi.fn(async () => {}),
      close: async () => {},
    } as SessionService
    const server = createAcpServer({ service })
    const app = client({ name: "vitest-client" })

    await app.connectWith(server, async (ctx) => {
      await init(ctx)
      const session = await ctx.buildSession(join(tmpdir(), "ih-acp-cwd")).start()
      const first = session.prompt("first")
      await firstStartedP
      const second = session.prompt("second")
      await secondStartedP

      finishFirst()
      await expect(first).resolves.toEqual({ stopReason: "end_turn" })
      await ctx.notify("session/cancel", { sessionId: session.sessionId })
      const secondWasAborted = secondSignal?.aborted
      finishSecond()
      const secondResult = await second
      expect(secondWasAborted).toBe(true)
      expect(secondResult).toEqual({ stopReason: "cancelled" })
    })
  })

  it("session/close aborts an active prompt before disposing the assembly", async () => {
    let started!: () => void
    const startedP = new Promise<void>((resolve) => { started = resolve })
    let submitSignal: AbortSignal | undefined
    const order: string[] = []
    const service = {
      submit: vi.fn(async (_sessionId: string, _prompt: string, signal: AbortSignal) => {
        submitSignal = signal
        started()
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            order.push("abort")
            reject(new Error("aborted"))
          }, { once: true })
        })
      }),
      assemblyFor: vi.fn(async () => { throw new Error("unused") }),
      liveSession: () => undefined,
      hasAssembly: () => false,
      queueState: () => ({ running: false, queued: 0 }),
      onAssembly: () => () => {},
      closeSession: vi.fn(async () => {
        expect(submitSignal?.aborted).toBe(true)
        order.push("dispose")
      }),
      close: async () => {},
    } as SessionService
    const server = createAcpServer({ service })
    const app = client({ name: "vitest-client" })

    await app.connectWith(server, async (ctx) => {
      await init(ctx)
      const session = await ctx.buildSession(join(tmpdir(), "ih-acp-cwd")).start()
      const prompt = session.prompt("wait")
      await startedP
      const close = ctx.request("session/close", { sessionId: session.sessionId })
      await expect(prompt).resolves.toEqual({ stopReason: "cancelled" })
      await expect(close).resolves.toEqual({})
    })

    expect(order).toEqual(["abort", "dispose"])
  })

  it("concurrent session/close requests share one lifecycle flight", async () => {
    const closeSession = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    const service = {
      submit: vi.fn(async () => {}),
      assemblyFor: vi.fn(async () => { throw new Error("unused") }),
      liveSession: () => undefined,
      hasAssembly: () => false,
      queueState: () => ({ running: false, queued: 0 }),
      onAssembly: () => () => {},
      closeSession,
      close: async () => {},
    } as SessionService
    const server = createAcpServer({ service })
    const app = client({ name: "vitest-client" })

    await app.connectWith(server, async (ctx) => {
      await init(ctx)
      const session = await ctx.buildSession(join(tmpdir(), "ih-acp-cwd")).start()
      await expect(Promise.all([
        ctx.request("session/close", { sessionId: session.sessionId }),
        ctx.request("session/close", { sessionId: session.sessionId }),
      ])).resolves.toEqual([{}, {}])
    })

    expect(closeSession).toHaveBeenCalledTimes(1)
  })

  it("a resume that loses to session/close cannot reactivate the session", async () => {
    const firstProfile = Promise.withResolvers<void>()
    const firstProfileStarted = Promise.withResolvers<void>()
    let profileCalls = 0
    const service = {
      submit: vi.fn(async () => {}),
      assemblyFor: vi.fn(async () => { throw new Error("unused") }),
      liveSession: () => undefined,
      hasAssembly: () => false,
      queueState: () => ({ running: false, queued: 0 }),
      onAssembly: () => () => {},
      closeSession: vi.fn(async () => {}),
      close: async () => {},
    } as SessionService
    const coordinator = {
      profile: vi.fn(async (_sessionId: string) => {
        profileCalls += 1
        if (profileCalls === 1) {
          firstProfileStarted.resolve()
          await firstProfile.promise
        }
        return {
          meta: { formatVersion: 1, sessionId: "existing", createdAt: new Date().toISOString() },
          blank: false,
        }
      }),
      adoptOwnership: vi.fn(async (_sessionId: string) => {}),
      flush: vi.fn(async (_sessionId: string) => {}),
      releaseOwnership: vi.fn(async (_sessionId: string) => {}),
    } as unknown as SessionCoordinator
    const server = createAcpServer({ service, coordinator })
    const app = client({ name: "vitest-client" })

    await app.connectWith(server, async (ctx) => {
      await init(ctx)
      const resume = ctx.request("session/resume", { sessionId: "existing", cwd: join(tmpdir(), "ih-acp-cwd") })
      await firstProfileStarted.promise
      await expect(ctx.request("session/close", { sessionId: "existing" })).resolves.toEqual({})
      firstProfile.resolve()
      await expect(resume).rejects.toThrow()
      await expect(ctx.request("session/prompt", {
        sessionId: "existing",
        prompt: [{ type: "text", text: "must stay closed" }],
      })).rejects.toThrow()
    })

    expect(service.submit).not.toHaveBeenCalled()
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

async function stopCli(child: ChildProcessWithoutNullStreams, stderrText: () => string): Promise<number> {
  child.stdin.end()
  return new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CLI did not exit; stderr: " + stderrText())), 15000)
    child.on("exit", (exitCode) => {
      clearTimeout(timer)
      resolve(exitCode ?? -1)
    })
  })
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

  it("restores one durable session across ACP process restarts without duplicate seqs", async () => {
    const repoRoot = fileURLToPath(new URL("../../..", import.meta.url))
    const cliEntry = fileURLToPath(new URL("../../../apps/cli/src/index.ts", import.meta.url))
    const cwd = await mkdtemp(join(tmpdir(), "ih-acp-resume-cwd-"))
    const sessionDir = await mkdtemp(join(tmpdir(), "ih-acp-resume-sess-"))
    const args = ["--import", "tsx", cliEntry, "acp", "--session-dir", sessionDir]
    let sessionId = ""

    const first = spawn(process.execPath, args, { cwd: repoRoot, stdio: ["pipe", "pipe", "pipe"] })
    const firstIo = drive(first)
    try {
      firstIo.send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: ACP_PROTOCOL_VERSION, clientInfo: { name: "vitest-client", version: "0.0.0" } },
      })
      await firstIo.waitFor((message) => message.id === 1, "first initialize")
      firstIo.send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd, mcpServers: [] } })
      const created = await firstIo.waitFor((message) => message.id === 2, "first session/new")
      sessionId = (created.result as { sessionId: string }).sessionId
      firstIo.send({
        jsonrpc: "2.0",
        id: 3,
        method: "session/prompt",
        params: { sessionId, prompt: [{ type: "text", text: "first prompt" }] },
      })
      await firstIo.waitFor((message) => message.id === 3, "first prompt")
      expect(await stopCli(first, firstIo.stderrText)).toBe(0)
    } finally {
      if (first.exitCode === null) first.kill()
    }

    const second = spawn(process.execPath, args, { cwd: repoRoot, stdio: ["pipe", "pipe", "pipe"] })
    const secondIo = drive(second)
    try {
      secondIo.send({
        jsonrpc: "2.0",
        id: 10,
        method: "initialize",
        params: { protocolVersion: ACP_PROTOCOL_VERSION, clientInfo: { name: "vitest-client", version: "0.0.0" } },
      })
      await secondIo.waitFor((message) => message.id === 10, "second initialize")
      secondIo.send({ jsonrpc: "2.0", id: 11, method: "session/resume", params: { sessionId, cwd } })
      await secondIo.waitFor((message) => message.id === 11, "second session/resume")
      secondIo.send({
        jsonrpc: "2.0",
        id: 12,
        method: "session/prompt",
        params: { sessionId, prompt: [{ type: "text", text: "second prompt" }] },
      })
      await secondIo.waitFor((message) => message.id === 12, "second prompt")
      expect(await stopCli(second, secondIo.stderrText)).toBe(0)

      const lines = (await readFile(join(sessionDir, `${sessionId}.jsonl`), "utf8")).trim().split("\n")
      const events = lines.slice(1).map((line) => JSON.parse(line) as { type: string; text?: string; seq?: number })
      expect(events
        .filter((event) => event.type === "user/message" && (event.text === "first prompt" || event.text === "second prompt"))
        .map((event) => event.text)).toEqual([
        "first prompt",
        "second prompt",
      ])
      expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index))
    } finally {
      if (second.exitCode === null) second.kill()
      await rm(cwd, { recursive: true, force: true }).catch(() => {})
      await rm(sessionDir, { recursive: true, force: true }).catch(() => {})
    }
  }, 60_000)
})
