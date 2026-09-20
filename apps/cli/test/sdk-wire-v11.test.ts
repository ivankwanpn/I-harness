// M41b v1.1: REAL-subprocess e2e of the v1.1 appendix — `i-harness sdk`
// spawned via node --import tsx, driven by HarnessClient over stdio:
// initialize capability rows, session/list enrichment (updatedAt/turnCount
// over a real store), session/cancel honest answers, and the session/rewind
// round trip through the CLI's rewindFactory (embedded-bridge pattern) with a
// PRE-SEEDED rewind point (the subprocess's default mock turn never writes a
// file, so the durable rewind fixture is written by THIS test via
// @i-harness/rewind's RewindStore — the same store root the CLI wires).
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import { createServer } from "node:http"
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { createHarnessClient } from "@i-harness/sdk"
import { RewindStore, sha256Hex } from "@i-harness/rewind"
import type { CancelResult, RewindPointsResponse, RewindPlanResponse, RewindExecuteResponse, SessionModelSelection } from "@i-harness/sdk"

const REPO_ROOT = resolve(fileURLToPath(new URL("../../../", import.meta.url)))
const TSX_LOADER = pathToFileURL(join(REPO_ROOT, "node_modules", "tsx", "dist", "loader.mjs")).href
const CLI_ENTRY = join(REPO_ROOT, "apps", "cli", "src", "index.ts")

async function startFixtureModel(): Promise<{ baseURL: string; paths: string[]; close(): Promise<void> }> {
  // Task 4: the fixture records the request PATH per call — `/v1/chat/completions`
  // is the openai-compatible wire, `/v1/messages` the anthropic-messages one, so
  // the recorded path is the evidence of which protocol a client spoke. Both
  // answer a stream carrying the same text ("fixture ok"): the path, never the
  // body, is what a rebind test reads.
  const paths: string[] = []
  const server = createServer((req, res) => {
    if (req.method !== "POST" || (req.url !== "/v1/chat/completions" && req.url !== "/v1/messages")) {
      res.writeHead(404).end()
      return
    }
    paths.push(req.url)
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.end((req.url === "/v1/messages"
      ? [
        `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "fixture ok" } })}`,
        `data: ${JSON.stringify({ type: "message_stop" })}`,
        "",
      ]
      : [
        `data: ${JSON.stringify({ choices: [{ delta: { content: "fixture ok" } }] })}`,
        "data: [DONE]",
        "",
      ]).join("\n\n"))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("fixture model failed to listen")
  return {
    baseURL: `http://127.0.0.1:${address.port}`,
    paths,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error))
      server.closeAllConnections()
    }),
  }
}

function seedCanonicalProvider(configDir: string, baseURL: string): void {
  writeFileSync(join(configDir, "settings.json"), JSON.stringify({
    llm: {
      providers: {
        fixture: {
          protocol: "openai-completions",
          baseURL,
          apiKeyEnv: "FIXTURE_API_KEY",
          models: [{ id: "fixture-model" }],
        },
      },
      defaultModel: { provider: "fixture", model: "fixture-model" },
    },
  }), "utf8")
  writeFileSync(join(configDir, "credentials.json"), JSON.stringify({
    refs: { FIXTURE_API_KEY: "fixture-key" },
  }), "utf8")
}

describe("i-harness sdk wire v1.1 end-to-end (real subprocess)", () => {
  let fixture: Awaited<ReturnType<typeof startFixtureModel>>
  let canonicalConfigDir: string

  beforeAll(async () => {
    fixture = await startFixtureModel()
    canonicalConfigDir = mkdtempSync(join(tmpdir(), "ih-sdk-w11-config-"))
    seedCanonicalProvider(canonicalConfigDir, fixture.baseURL)
  })

  afterAll(async () => {
    await fixture.close().catch(() => {})
    rmSync(canonicalConfigDir, { recursive: true, force: true })
  })
  it(
    "creates, forks, and persists session model selection from canonical settings",
    async () => {
      const workspace = mkdtempSync(join(tmpdir(), "ih-sdk-model-ws-"))
      const sessionDir = mkdtempSync(join(tmpdir(), "ih-sdk-model-sess-"))
      const configDir = mkdtempSync(join(tmpdir(), "ih-sdk-model-config-"))
      writeFileSync(join(configDir, "settings.json"), JSON.stringify({
        llm: {
          providers: {
            fixture: {
              protocol: "openai-completions",
              baseURL: fixture.baseURL,
              apiKeyEnv: "FIXTURE_API_KEY",
              models: [{ id: "fixture-model" }, { id: "alternate-model" }],
            },
          },
          defaultModel: { provider: "fixture", model: "fixture-model" },
        },
      }), "utf8")
      writeFileSync(join(configDir, "credentials.json"), JSON.stringify({
        refs: { FIXTURE_API_KEY: "fixture-key" },
      }), "utf8")
      writeFileSync(join(sessionDir, "s1.jsonl"), `${JSON.stringify({
        formatVersion: 1,
        sessionId: "s1",
        createdAt: "2026-09-06T00:00:00.000Z",
        workspaceId: "ws-source",
      })}\n`, "utf8")

      const client = createHarnessClient({
        command: process.execPath,
        args: ["--import", TSX_LOADER, CLI_ENTRY, "sdk", "--session-dir", sessionDir],
        cwd: workspace,
        env: { IH_CONFIG_DIR: configDir },
      })
      try {
        const info = await client.initialize()
        expect(info.capabilities["session-create"]).toEqual(["1"])
        expect(info.capabilities["session-fork"]).toEqual(["1"])
        expect(info.capabilities["session-model"]).toEqual(["1"])
        await expect(client.modelState("s1")).resolves.toEqual({
          status: "ready",
          providerId: "fixture",
          modelId: "fixture-model",
          label: "fixture:fixture-model",
        })
        await expect(client.setSessionModel("s1", {
          provider: "fixture",
          model: "alternate-model",
          reasoningEffort: "high",
        })).resolves.toEqual({
          status: "ready",
          providerId: "fixture",
          modelId: "alternate-model",
          label: "fixture:alternate-model",
        })
        const header = JSON.parse(readFileSync(join(sessionDir, "s1.jsonl"), "utf8").split("\n")[0]!) as {
          modelSelection?: { provider: string; model: string; reasoningEffort?: string }
        }
        expect(header.modelSelection).toEqual({
          provider: "fixture",
          model: "alternate-model",
          reasoningEffort: "high",
        })

        await expect(client.run({ sessionId: "s1", prompt: "fork source" })).resolves.toMatchObject({
          text: expect.stringContaining("fixture ok"),
        })
        const forked = await client.forkSession("s1")
        expect(forked.sessionId).not.toBe("s1")
        const forkHeader = JSON.parse(
          readFileSync(join(sessionDir, `${forked.sessionId}.jsonl`), "utf8").split("\n")[0]!,
        ) as { workspaceId?: string }
        expect(forkHeader.workspaceId).toBe("ws-source")
        const forkHistory = await client.history(forked.sessionId)
        expect(forkHistory.events.some((event) => event.type === "user/message" && event.text === "fork source")).toBe(true)
        expect(forkHistory.events.at(-1)?.type).toBe("turn/end")

        const created = await client.createSession()
        expect(created.sessionId).not.toBe("")
        await expect(client.modelState(created.sessionId)).resolves.toMatchObject({
          status: "ready",
          providerId: "fixture",
          modelId: "fixture-model",
        })
      } finally {
        await client.close().catch(() => {})
        rmSync(workspace, { recursive: true, force: true })
        rmSync(sessionDir, { recursive: true, force: true })
        rmSync(configDir, { recursive: true, force: true })
      }
    },
    30_000,
  )

  // PHASE B TASK 4 — THE LIVE REBIND, half (a). The wire's `protocol` is for the
  // LIVE session only (§4.2②): the assertable consequence is an ENDPOINT. One
  // session, one process, one subprocess: its first turn speaks the ROUTE's
  // protocol (openai-completions → /v1/chat/completions), then `session/model/set`
  // names anthropic-messages, and its NEXT turn speaks that one (/v1/messages).
  //
  // A rebind that only took effect on the NEXT assembly could not pass this:
  // the protocol is never persisted (§4.3), so a rebuilt assembly would resolve
  // the route's wire again. That is exactly why (a) and (b) are two halves of
  // one decision — (a) without (b) would mean a protocol reached a file; (b)
  // without (a) is phase A, which already shipped.
  it(
    "a protocol on the wire rebinds the LIVE session — the next turn moves to the new endpoint",
    async () => {
      const workspace = mkdtempSync(join(tmpdir(), "ih-sdk-rebind-ws-"))
      const sessionDir = mkdtempSync(join(tmpdir(), "ih-sdk-rebind-sess-"))
      writeFileSync(join(sessionDir, "s1.jsonl"), `${JSON.stringify({
        formatVersion: 1,
        sessionId: "s1",
        createdAt: "2026-09-06T00:00:00.000Z",
      })}\n`, "utf8")
      const before = fixture.paths.length

      const client = createHarnessClient({
        command: process.execPath,
        args: ["--import", TSX_LOADER, CLI_ENTRY, "sdk", "--session-dir", sessionDir],
        cwd: workspace,
        env: { IH_CONFIG_DIR: canonicalConfigDir },
      })
      try {
        // control: before the rebind the route's declared wire is what this
        // session speaks — so the switch below is attributable to the rebind.
        await client.run({ sessionId: "s1", prompt: "before" })
        expect(fixture.paths.slice(before)).toEqual(["/v1/chat/completions"])

        // Annotated ON PURPOSE: `protocol` is part of the wire type now — in
        // phase A its absence from `SessionModelSelection` was the guard.
        const selection: SessionModelSelection = { provider: "fixture", model: "fixture-model", protocol: "anthropic-messages" }
        await expect(client.setSessionModel("s1", selection))
          .resolves.toMatchObject({ status: "ready", label: "fixture:fixture-model" })

        // HALF (a): the LIVE session's next turn is on the NEW endpoint. The
        // session was opened by the run above, so this is the same assembly —
        // and its handle is what the turn reads the client through.
        const after = await client.run({ sessionId: "s1", prompt: "after" })
        expect(after.text).toContain("fixture ok")
        expect(fixture.paths.slice(before)).toEqual(["/v1/chat/completions", "/v1/messages"])

        // HALF (b): the rebind that made (a) true still wrote NO protocol
        // anywhere durable (§4.3). Same invariant as the guard below, on the
        // live path — because the live path is the new one.
        const header = JSON.parse(readFileSync(join(sessionDir, "s1.jsonl"), "utf8").split("\n")[0]!) as {
          modelSelection?: Record<string, unknown>
        }
        expect(header.modelSelection).toEqual({ provider: "fixture", model: "fixture-model" })
      } finally {
        await client.close().catch(() => {})
        rmSync(workspace, { recursive: true, force: true })
        rmSync(sessionDir, { recursive: true, force: true })
      }
    },
    60_000,
  )

  // THE INVARIANT, pinned — and this guard was REWRITTEN deliberately, not
  // weakened. It was planted in phase A to force this decision: its old form
  // sent `protocol` through an `as SessionModelSelection` cast and called
  // widening the parser "the phase-B mistake". Phase B widened it — the wire
  // now carries `protocol?` for the REBIND path (§4.2②; see the whitelist note
  // in packages/sdk/src/server.ts) — so the cast is gone and the field is part
  // of the contract. What did NOT change is the half this guard exists for:
  // §4.3 — a session's protocol is written to NO file, so the header must never
  // gain one. It is red for exactly one mistake (Task 4's mutation proof):
  // removing the relay's strip step, i.e. handing the whole selection to
  // `updateMeta`, whose durable type already accepts `protocol`. Half (a) — the
  // live rebind — is pinned in the test above.
  it(
    "still never persists a protocol to the session header (§4.3: the half that must not change)",
    async () => {
      const workspace = mkdtempSync(join(tmpdir(), "ih-sdk-noproto-ws-"))
      const sessionDir = mkdtempSync(join(tmpdir(), "ih-sdk-noproto-sess-"))
      writeFileSync(join(sessionDir, "s1.jsonl"), `${JSON.stringify({
        formatVersion: 1,
        sessionId: "s1",
        createdAt: "2026-09-06T00:00:00.000Z",
      })}\n`, "utf8")

      const client = createHarnessClient({
        command: process.execPath,
        args: ["--import", TSX_LOADER, CLI_ENTRY, "sdk", "--session-dir", sessionDir],
        cwd: workspace,
        env: { IH_CONFIG_DIR: canonicalConfigDir },
      })
      try {
        await expect(client.setSessionModel("s1", {
          provider: "fixture",
          model: "fixture-model",
          protocol: "anthropic-messages",
        })).resolves.toMatchObject({ status: "ready" })
        const header = JSON.parse(readFileSync(join(sessionDir, "s1.jsonl"), "utf8").split("\n")[0]!) as {
          modelSelection?: Record<string, unknown>
        }
        expect(header.modelSelection).not.toHaveProperty("protocol")
        expect(header.modelSelection).toEqual({ provider: "fixture", model: "fixture-model" })

        // No silent degradation for a protocol the host cannot resolve: it is
        // REFUSED with the five-value message (`provider add --protocol`'s same
        // rule), and the refusal writes nothing — the header above stays the
        // honest selection.
        await expect(client.setSessionModel("s1", {
          provider: "fixture",
          model: "fixture-model",
          protocol: "not-a-wire",
        })).rejects.toMatchObject({ code: -32603, message: expect.stringContaining('unknown protocol "not-a-wire"') })
        const afterRefusal = JSON.parse(readFileSync(join(sessionDir, "s1.jsonl"), "utf8").split("\n")[0]!) as {
          modelSelection?: Record<string, unknown>
        }
        expect(afterRefusal.modelSelection).toEqual({ provider: "fixture", model: "fixture-model" })
      } finally {
        await client.close().catch(() => {})
        rmSync(workspace, { recursive: true, force: true })
        rmSync(sessionDir, { recursive: true, force: true })
      }
    },
    30_000,
  )

  it(
    "cancel + rewind/* + enriched list rows over the real CLI server",
    async () => {
      const workspace = mkdtempSync(join(tmpdir(), "ih-sdk-w11-ws-"))
      const sessionDir = mkdtempSync(join(tmpdir(), "ih-sdk-w11-sess-"))
      // workspace fixture: a file the seeded rewind point "created" in turn 0
      const aPath = join(workspace, "a.txt")
      writeFileSync(aPath, "hello")
      // M58 R-B4 A: a git work tree so plan().unseen has something to observe
      // (the recorder never sees the shell writes added below).
      const git = (...args: string[]): void => {
        execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], {
          cwd: workspace,
          stdio: "ignore",
        })
      }
      writeFileSync(join(workspace, "base.txt"), "v1")
      git("init", "-q")
      git("add", "-A")
      git("commit", "-q", "-m", "base")
      // the durable rewind fixture — the same store layout the CLI wires
      // (rewindStoreRoot = the session dir → <dir>/rewind/<sessionId>/…)
      const store = new RewindStore({ root: sessionDir, sessionId: "sdk-w11" })
      await store.appendPoint({
        turnIndex: 0,
        anchorSeq: 0,
        promptPreview: "seeded",
        files: [{ path: "a.txt", status: "added", isNewFile: true, afterHash: sha256Hex(new TextEncoder().encode("hello")) }],
      })

      const client = createHarnessClient({
        command: process.execPath,
        args: ["--import", TSX_LOADER, CLI_ENTRY, "sdk", "--session-dir", sessionDir],
        cwd: workspace,
        env: { IH_CONFIG_DIR: canonicalConfigDir },
      })
      try {
        // handshake: v1.1 capability rows (protocolVersion stays 2)
        const info = (await client.request("initialize", {})) as {
          protocolVersion: number
          capabilities: Record<string, string[]>
        }
        expect(info.protocolVersion).toBe(2)
        expect(info.capabilities["session-cancel"]).toEqual(["1"])
        expect(info.capabilities["session-rewind"]).toEqual(["1"])
        expect(info.capabilities["session-create"]).toEqual(["1"])
        expect(info.capabilities["session-fork"]).toEqual(["1"])
        expect(info.capabilities["session-model"]).toEqual(["1"])

        // one turn → the live assembly (the rewind factory resolves it)
        const result = await client.run({ sessionId: "sdk-w11", prompt: "hello" })
        expect(result.text).toContain("ok")

        // cancel: honest answers — unknown ("ghost") → not-found; the run
        // session is known + idle → not-running
        expect(await client.cancel("ghost")).toEqual<CancelResult>({ cancelled: false, reason: "not-found" })
        expect(await client.cancel("sdk-w11")).toEqual<CancelResult>({ cancelled: false, reason: "not-running" })

        // list enrichment: the row carries updatedAt + turnCount (the store
        // has real events + a real artifact mtime)
        const list = await client.listSessions()
        expect(list.listingUnavailable).toBeUndefined()
        const row = list.sessions.find((s) => s.id === "sdk-w11")
        expect(row).toBeDefined()
        expect(row!.updatedAt).toBeTypeOf("number")
        expect(row!.turnCount).toBeTypeOf("number")
        expect(row!.turnCount).toBeGreaterThanOrEqual(1)

        // rewind round trip via the wire — the factory serves the durable
        // points (pre-seeded turn 0) plus whatever the mock turn recorded
        const points = await client.rewindPoints("sdk-w11")
        expect<RewindPointsResponse>(points).toEqual({
          points: expect.arrayContaining([{ turnIndex: 0, preview: "seeded", files: 1 }]),
        })

        // plan: the seeded point's file is on the disk still matching its
        // afterHash → clean (delete-added restore); conversation mode → no ops
        // M58 R-B4 A: shell/external changes the recorder never saw → unseen
        // (base.txt modified after commit; shell.txt untracked).
        writeFileSync(join(workspace, "base.txt"), "v2")
        writeFileSync(join(workspace, "shell.txt"), "s")
        const plan = await client.rewindPlan("sdk-w11", 0, "conversation")
        expect<RewindPlanResponse>(plan).toMatchObject({
          clean: [{ path: "a.txt", op: "delete-added" }],
          conflicts: [],
          unTracked: [],
          ops: [],
          unseen: [
            { path: "base.txt", kind: "modified" },
            { path: "shell.txt", kind: "untracked" },
          ],
        })

        // execute (files mode): deletes the created file + appends the
        // rewind/point marker into the live session log (history sees it)
        const executed = await client.rewindExecute("sdk-w11", 0, "files")
        expect<RewindExecuteResponse>(executed).toMatchObject({ revertedFiles: 1, conflicts: [] })
        expect(existsSync(aPath)).toBe(false)
        const range = await client.history("sdk-w11")
        expect(range.events.map((e) => e.type)).toContain("rewind/point")
      } finally {
        await client.close().catch(() => {})
        rmSync(workspace, { recursive: true, force: true })
        rmSync(sessionDir, { recursive: true, force: true })
      }
    },
    120_000,
  )

  it(
    "holds ownership for a newly opened session and rejects a second process resuming it",
    async () => {
      const workspace = mkdtempSync(join(tmpdir(), "ih-sdk-owner-ws-"))
      const sessionDir = mkdtempSync(join(tmpdir(), "ih-sdk-owner-sess-"))
      const first = createHarnessClient({
        command: process.execPath,
        args: ["--import", TSX_LOADER, CLI_ENTRY, "sdk", "--session-dir", sessionDir],
        cwd: workspace,
        env: { IH_CONFIG_DIR: canonicalConfigDir },
      })
      const second = createHarnessClient({
        command: process.execPath,
        args: ["--import", TSX_LOADER, CLI_ENTRY, "sdk", "--session-dir", sessionDir],
        cwd: workspace,
        env: { IH_CONFIG_DIR: canonicalConfigDir },
      })
      try {
        await first.request("initialize", {})
        await second.request("initialize", {})
        await expect(first.run({ sessionId: "sdk-owner", prompt: "open" })).resolves.toMatchObject({
          sessionId: "sdk-owner",
        })

        await expect(second.run({ sessionId: "sdk-owner", prompt: "resume" })).rejects.toMatchObject({
          code: -32603,
        })
      } finally {
        await second.close().catch(() => {})
        await first.close().catch(() => {})
        rmSync(workspace, { recursive: true, force: true })
        rmSync(sessionDir, { recursive: true, force: true })
      }
    },
    120_000,
  )

  it(
    "restores one durable session across SDK process restarts without duplicate seqs",
    async () => {
      const workspace = mkdtempSync(join(tmpdir(), "ih-sdk-resume-ws-"))
      const sessionDir = mkdtempSync(join(tmpdir(), "ih-sdk-resume-sess-"))
      const args = ["--import", TSX_LOADER, CLI_ENTRY, "sdk", "--session-dir", sessionDir]
      const first = createHarnessClient({ command: process.execPath, args, cwd: workspace, env: { IH_CONFIG_DIR: canonicalConfigDir } })
      try {
        await first.request("initialize", {})
        await first.run({ sessionId: "sdk-resume", prompt: "first prompt" })
      } finally {
        await first.close().catch(() => {})
      }

      const second = createHarnessClient({ command: process.execPath, args, cwd: workspace, env: { IH_CONFIG_DIR: canonicalConfigDir } })
      try {
        await second.request("initialize", {})
        await second.run({ sessionId: "sdk-resume", prompt: "second prompt" })
        const history = await second.history("sdk-resume")
        const prompts = history.events.flatMap((event) =>
          event.type === "user/message" && (event.text === "first prompt" || event.text === "second prompt")
            ? [event.text]
            : [],
        )
        expect(prompts).toEqual([
          "first prompt",
          "second prompt",
        ])
        expect(history.events.map((event) => event.seq)).toEqual(history.events.map((_, index) => index))
      } finally {
        await second.close().catch(() => {})
        rmSync(workspace, { recursive: true, force: true })
        rmSync(sessionDir, { recursive: true, force: true })
      }
    },
    120_000,
  )

  it(
    "persists crash-tail recovery before SDK continuation and a second restart",
    async () => {
      const workspace = mkdtempSync(join(tmpdir(), "ih-sdk-crash-ws-"))
      const sessionDir = mkdtempSync(join(tmpdir(), "ih-sdk-crash-sess-"))
      const sessionId = "sdk-crash-recovery"
      const sessionPath = join(sessionDir, `${sessionId}.jsonl`)
      writeFileSync(sessionPath, [
        JSON.stringify({ formatVersion: 1, sessionId, createdAt: "2026-09-06T00:00:00.000Z" }),
        JSON.stringify({ type: "turn/start", seq: 0 }),
        JSON.stringify({ type: "step/start", seq: 1 }),
        JSON.stringify({ type: "tool/call", callId: "lost", name: "bash", args: { cmd: "echo hi" }, seq: 2 }),
        "",
      ].join("\n"), "utf8")
      const args = ["--import", TSX_LOADER, CLI_ENTRY, "sdk", "--session-dir", sessionDir]

      const first = createHarnessClient({ command: process.execPath, args, cwd: workspace, env: { IH_CONFIG_DIR: canonicalConfigDir } })
      try {
        await first.request("initialize", {})
        await first.run({ sessionId, prompt: "continue after crash" })
      } finally {
        await first.close().catch(() => {})
      }

      const rawAfterFirst = readFileSync(sessionPath, "utf8").trim().split("\n").slice(1)
        .map((line) => JSON.parse(line) as { type: string; seq?: number; output?: { code?: string } })
      expect(rawAfterFirst.map((event) => event.seq)).toEqual(rawAfterFirst.map((_, index) => index))
      expect(rawAfterFirst.some((event) => event.type === "tool/result" && event.output?.code === "TOOL_ABORTED_BEFORE_DISPATCH")).toBe(true)

      const second = createHarnessClient({ command: process.execPath, args, cwd: workspace, env: { IH_CONFIG_DIR: canonicalConfigDir } })
      try {
        await second.request("initialize", {})
        await second.run({ sessionId, prompt: "second restart" })
        const history = await second.history(sessionId)
        expect(history.events.some((event) =>
          event.type === "tool/result"
          && (event.output as { code?: string }).code === "TOOL_ABORTED_BEFORE_DISPATCH",
        )).toBe(true)
      } finally {
        await second.close().catch(() => {})
        rmSync(workspace, { recursive: true, force: true })
        rmSync(sessionDir, { recursive: true, force: true })
      }
    },
    120_000,
  )
})
