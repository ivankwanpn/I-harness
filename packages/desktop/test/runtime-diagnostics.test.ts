import { afterEach, describe, expect, it } from "vitest"
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, utimes, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRuntimeDiagnostics } from "../src/main/runtime-diagnostics.ts"
import type { DesktopEvent } from "../src/shared/bridge.ts"
import { RpcError, SdkRunError } from "@i-harness/sdk"

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function root() { const value = await mkdtemp(join(tmpdir(), "ih-runtime-diagnostics-")); roots.push(value); return value }
const event = (type: string, data: Record<string, unknown> = {}, sessionId = "s", workspaceId = "ws"): DesktopEvent => ({ kind: "sdk/notification", workspaceId, method: "session/event", params: { sessionId, event: { type, ...data } } })
const status = (state: string, error?: string, sessionId = "s"): DesktopEvent => ({ kind: "sdk/notification", workspaceId: "ws", method: "session/status", params: { sessionId, status: state, error } })
const retry = { requestId: "req-1", phase: "waiting", attempt: 1, maxRetries: 5, delayMs: 500, code: "http_503", httpStatus: 503, providerId: "local", modelId: "model" }

describe("native runtime diagnostics", () => {
  it.each(["failed", "cancelled", "completed"])("does not attribute delayed %s status to a busy replacement retry", async terminal => {
    const service = createRuntimeDiagnostics(await root())
    const phases: string[] = []
    service.onActivity(value => phases.push(value.activity.phase))
    const execution = (running: boolean, queued: number, revision: number) => service.observe({ kind: "sdk/notification", workspaceId: "ws", method: "session/execution-state", params: { sessionId: "s", running, queued, revision } })
    execution(true, 0, 7)
    service.observe(event("turn/start", { seq: 20 }))
    service.observe(event("model/retry", { version: 1, retry }))
    const activity = (phase: string) => service.observe(event("model/activity", { version: 1, activity: { requestId: "physical-new", phase, startedAt: 1000, waitingFor: "progress" } }))
    activity("connecting")
    execution(false, 0, 6) // An older idle notification cannot override busy truth.
    service.observe(status(terminal, "HTTP 401"))
    activity("quiet")
    expect(phases).toEqual(["connecting", "quiet"])
    const older = (await service.list()).entries.filter(entry => entry.kind === "session/error" || entry.kind === "session/cancelled")
    expect(older).toHaveLength(terminal === "completed" ? 0 : 1)
    expect(older.every(entry => entry.requestId === undefined)).toBe(true)
    expect(older.every(entry => entry.executionUncorrelated === true)).toBe(true)
    execution(false, 1, 8)
    service.observe(status(terminal, "HTTP 401"))
    activity("quiet")
    expect(phases).toEqual(["connecting", "quiet", "quiet"])
    execution(false, 0, 9)
    service.observe(status("failed", "HTTP 503"))
    expect((await service.list()).entries.find(entry => entry.code === "http_503")).toMatchObject({ requestId: "req-1" })
    activity("quiet")
    expect(phases).toHaveLength(3)
  })

  it("attributes retries, recovery and new failures while deduplicating delivery and suppressing cancellation errors", async () => {
    const service = createRuntimeDiagnostics(await root())
    service.observe(event("turn/start", { seq: 1 }))
    service.observe(event("model/retry", { version: 1, ts: Date.now(), retry, seq: 2 }))
    service.observe(event("model/retry", { version: 1, ts: Date.now(), retry, seq: 2 }))
    service.observe(event("model/retry", { version: 1, retry: { ...retry, phase: "recovered" }, seq: 3 }))
    service.observe(status("completed"))
    service.observe(event("turn/start", { seq: 8 }))
    service.observe(status("failed", "OpenAI HTTP 401: {body: 'private prompt'}"))
    service.observe(status("failed", "OpenAI HTTP 401: {body: 'private prompt'}"))
    service.recordRequestFailure("ws", "s", new Error("OpenAI HTTP 401: private prompt"))
    service.observe(event("turn/start", { seq: 12 }))
    service.observe(status("error", "OpenAI HTTP 401: private prompt"))
    service.observe(event("turn/start", { seq: 15 }))
    service.observe(status("failed", "AbortError: operation aborted"))
    const { entries } = await service.list()
    expect(entries.map(row => row.kind)).toEqual(["session/cancelled", "session/error", "session/error", "model/recovered", "model/retry"])
    expect(entries.filter(row => row.level === "error")).toHaveLength(2)
    expect(entries.at(-1)).toMatchObject({ workspaceId: "ws", sessionId: "s", requestId: "req-1", retry })
    expect(JSON.stringify(entries)).not.toContain("private prompt")
  })

  it("shares an allowlisted redacted boundary across live delivery, disk, restart, copy and picker export", async () => {
    const dir = await root(); const output = join(await root(), "safe.json")
    let copied = ""; let revealed = ""; const live: unknown[] = []
    const service = createRuntimeDiagnostics(dir, { copy: text => { copied = text }, pickExport: async () => output, reveal: async path => { revealed = path } })
    service.onEntry(entry => live.push(entry))
    service.observe(event("model/retry", { version: 1, retry: { ...retry, providerId: "sk-secret12345678", body: "private-body", args: { prompt: "private-tool" }, authorization: "Bearer custom-token" } }))
    service.observe(status("failed", "Malformed tool arguments: private-tool Bearer custom-token"))
    service.observe({ kind: "sdk/disconnected", workspaceId: "ws", message: "raw subprocess stderr private-body" })
    const listed = await service.list()
    expect(live).toHaveLength(3)
    const restarted = createRuntimeDiagnostics(dir)
    expect(await restarted.list()).toEqual(listed)
    await service.copy(listed.entries[0]!.id)
    await service.export({ workspaceId: "ws" })
    await service.reveal()
    const disk = (await Promise.all((await readdir(dir)).map(file => readFile(join(dir, file), "utf8")))).join("")
    const exported = await readFile(output, "utf8")
    for (const text of [disk, copied, exported, JSON.stringify(live)]) {
      for (const secret of ["private-body", "private-tool", "custom-token", "sk-secret12345678", "raw subprocess stderr"]) expect(text).not.toContain(secret)
    }
    expect(exported).toContain("[REDACTED]")
    expect(revealed).toBe(dir)
    expect(JSON.parse(exported).entries).toEqual(listed.entries)
    expect(JSON.parse(copied)).toEqual(listed.entries[0])
  })

  it("delivers live errors despite failed storage and isolates throwing subscribers", async () => {
    const dir = join(await root(), "file"); await writeFile(dir, "occupied")
    const service = createRuntimeDiagnostics(dir); const entries: unknown[] = []
    service.onEntry(() => { throw new Error("subscriber failure") })
    service.onEntry(entry => entries.push(entry))
    expect(() => service.observe(status("failed", "HTTP 500: private payload"))).not.toThrow()
    await service.flush()
    expect(entries).toHaveLength(1)
    expect(await service.list()).toMatchObject({ entries: [{ kind: "session/error" }], storageError: expect.any(String) })
  })

  it("bounds views and exports, filters scope/severity/search, and keeps the writer free during a save picker", async () => {
    let finishPicker: (value: string | undefined) => void = () => {}
    const service = createRuntimeDiagnostics(await root(), { pickExport: () => new Promise(resolve => { finishPicker = resolve }) })
    for (let i = 0; i < 1005; i++) { service.observe(event("turn/start", { seq: i + 1 })); service.observe(status("failed", "HTTP 503")) }
    expect((await service.list()).entries).toHaveLength(1000)
    expect((await service.list({ sessionId: "other" })).entries).toEqual([])
    expect((await service.list({ level: "info" })).entries).toEqual([])
    expect((await service.list({ query: "503" })).entries).toHaveLength(1000)
    const exporting = service.export()
    // Let the export take its snapshot and enter its injected picker.
    await new Promise(resolve => setTimeout(resolve, 10))
    service.observe(status("cancelled"))
    await service.flush()
    finishPicker(undefined)
    expect(await exporting).toEqual({ exported: false, count: 0 })
  })

  it("rotates only owned bounded files, expires old records and rejects unsafe loaded payloads", async () => {
    const dir = await root(); await mkdir(dir, { recursive: true })
    const unrelated = join(dir, "session-journal.jsonl"); await writeFile(unrelated, "never touch")
    const old = Date.now() - 8 * 86400000
    await writeFile(join(dir, "runtime-diagnostics.2.jsonl"), JSON.stringify({ id: "old", timestamp: old, kind: "session/error", level: "error", message: "private raw body" }) + "\n")
    await utimes(join(dir, "runtime-diagnostics.2.jsonl"), old / 1000, old / 1000)
    const service = createRuntimeDiagnostics(dir)
    await service.list()
    await writeFile(join(dir, "runtime-diagnostics.0.jsonl"), "x".repeat(5 * 1024 * 1024))
    for (let i = 0; i < 3; i++) { service.observe(event("turn/start", { seq: i + 1 })); service.observe(status("failed", "HTTP 500")); await service.flush(); if (i < 2) await writeFile(join(dir, "runtime-diagnostics.0.jsonl"), "x".repeat(5 * 1024 * 1024)) }
    const names = await readdir(dir)
    expect(names.filter(name => name.startsWith("runtime-diagnostics."))).toHaveLength(3)
    for (const name of names.filter(name => name.startsWith("runtime-diagnostics."))) expect((await stat(join(dir, name))).size).toBeLessThanOrEqual(5 * 1024 * 1024)
    expect(await readFile(unrelated, "utf8")).toBe("never touch")
    const result = await service.list()
    expect(result.entries.every(row => row.timestamp > old && row.message !== "private raw body")).toBe(true)
  })
})

describe("diagnostic request identity and metadata", () => {
  it.each(["status-first", "rejection-first"])("recognizes default platform abort messages after SDK transport (%s)", async order => {
    const controller = new AbortController()
    controller.abort()
    const timerError = await import("node:timers/promises").then(({ setTimeout }) => setTimeout(1000, undefined, { signal: controller.signal }).catch(error => error))
    for (const error of [controller.signal.reason, timerError]) {
      const service = createRuntimeDiagnostics(await root())
      const statusDelivery = () => service.observe(status("failed", error.message))
      const rejection = () => service.recordRequestFailure("ws", "s", new RpcError(-32603, error.message))
      if (order === "status-first") { statusDelivery(); rejection() } else { rejection(); statusDelivery() }
      expect((await service.list()).entries).toMatchObject([{ kind: "session/cancelled", level: "info" }])
      expect((await service.list({ level: "error" })).entries).toEqual([])
    }
  })
  it.each(["failed", "error"])("treats the agent's actual cancellation through %s status and SDK wrappers as one informational outcome", async state => {
    const service = createRuntimeDiagnostics(await root())
    service.beginRequest("ws", "s", "token-cancel")
    // The agent throws Error('agent aborted'); gateway and SDK status forward
    // its message, while SDK request/run rejection wraps the same message.
    service.observe(status(state, "agent aborted"))
    service.recordRequestFailure("ws", "s", new RpcError(-32603, "agent aborted"))
    service.recordRequestFailure("ws", "s", new SdkRunError("agent aborted", -32603, undefined, []))
    expect((await service.list()).entries).toMatchObject([{ kind: "session/cancelled", level: "info", code: "cancelled" }])
    expect((await service.list({ level: "error" })).entries).toEqual([])
  })
  it.each([new Error("agent aborted"), new RpcError(-32603, "agent aborted"), new SdkRunError("agent aborted", -32603, undefined, [])])("recognizes the agent cancellation when request rejection arrives first: %s", async error => {
    const service = createRuntimeDiagnostics(await root())
    service.recordRequestFailure("ws", "s", error)
    service.observe(status("error", "agent aborted"))
    expect((await service.list()).entries).toMatchObject([{ kind: "session/cancelled", level: "info" }])
    expect((await service.list({ level: "error" })).entries).toEqual([])
  })
  it("does not suppress a provider body containing the exact agent cancellation phrase", async () => {
    const service = createRuntimeDiagnostics(await root())
    service.observe(status("failed", "OpenAI HTTP 500: {message: 'agent aborted'}"))
    expect((await service.list()).entries).toMatchObject([{ kind: "session/error", httpStatus: 500 }])
  })
  it("gives early request failures fresh identities and deduplicates status plus rejection by request", async () => {
    const service = createRuntimeDiagnostics(await root())
    service.beginRequest("ws", "s", "token-0001")
    service.recordRequestFailure("ws", "s", new Error("request failed: 401"))
    service.beginRequest("ws", "s", "token-0001")
    service.recordRequestFailure("ws", "s", new Error("request failed: 401"))
    service.beginRequest("ws", "s", "token-0002")
    service.observe(status("failed", "request failed: 401"))
    service.recordRequestFailure("ws", "s", new Error("request failed: 401"))
    expect((await service.list()).entries).toMatchObject([{ requestId: "token-0002", httpStatus: 401 }, { requestId: "token-0001", httpStatus: 401 }])
  })
  it("keeps capacity and structured status facts and treats structured abort as informational", async () => {
    const service = createRuntimeDiagnostics(await root())
    service.observe(event("model/retry", { version: 1, retry: { ...retry, code: "CAPACITY", delayMs: 10000 } }))
    service.recordRequestFailure("ws", "s", Object.assign(new Error("request failed"), { code: "ABORTED" }))
    const { entries } = await service.list()
    expect(entries).toMatchObject([{ kind: "session/cancelled", level: "info" }, { retry: { code: "CAPACITY", delayMs: 10000 }, message: expect.stringContaining("temporarily at capacity") }])
  })
  it("strips hostile loaded fields and expires stale records inside a recently modified owned file", async () => {
    const dir = await root()
    const old = Date.now() - 8 * 86400000
    await writeFile(join(dir, "runtime-diagnostics.0.jsonl"), [
      { id: "old", timestamp: old, kind: "session/error", level: "error", message: "expired-private-text" },
      { id: "safe", timestamp: Date.now(), kind: "session/error", level: "error", message: "live-private-text", body: "private-body", retry: { ...retry, authorization: "Bearer custom-token" } },
    ].map(row => JSON.stringify(row)).join("\n") + "\n")
    const service = createRuntimeDiagnostics(dir)
    const { entries } = await service.list()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ id: "safe", message: "Model request failed." })
    expect(JSON.stringify(entries)).not.toMatch(/private|authorization/)
    expect(await readFile(join(dir, "runtime-diagnostics.0.jsonl"), "utf8")).not.toContain("expired-private-text")
  })
  it("does not mistake cancellation text in a raw provider payload for a user abort", async () => {
    const service = createRuntimeDiagnostics(await root())
    service.observe(status("failed", "OpenAI HTTP 500: {message: 'user aborted', prompt: 'private'}"))
    expect((await service.list()).entries).toMatchObject([{ kind: "session/error", httpStatus: 500 }])
  })
  it("keeps the safe terminal capacity fact from the adapter without preserving upstream text", async () => {
    const service = createRuntimeDiagnostics(await root())
    service.observe(status("failed", "OpenAI request failed: 503 (model is at capacity)"))
    expect((await service.list()).entries).toMatchObject([{ code: "CAPACITY", httpStatus: 503, message: expect.stringContaining("temporarily at capacity") }])
  })
  it("redacts loaded record identifiers and deduplicates a shared startup rejection but preserves later attempts", async () => {
    const dir = await root()
    await writeFile(join(dir, "runtime-diagnostics.0.jsonl"), JSON.stringify({ id: "sk-secret12345678", timestamp: Date.now(), kind: "session/error" }) + "\n")
    const service = createRuntimeDiagnostics(dir)
    const shared = new Error("startup rejected")
    service.recordRequestFailure("ws", undefined, shared, "runtime/error")
    service.recordRequestFailure("ws", undefined, shared, "runtime/error")
    service.recordRequestFailure("ws", undefined, new Error("startup rejected"), "runtime/error")
    const result = await service.list()
    expect(result.entries.filter(row => row.kind === "runtime/error")).toHaveLength(2)
    expect(JSON.stringify(result)).not.toContain("sk-secret12345678")
  })
  it("exports at most the bounded safe view through the native picker", async () => {
    const output = join(await root(), "export.json")
    const service = createRuntimeDiagnostics(await root(), { pickExport: async () => output })
    for (let i = 0; i < 1005; i++) { service.observe(event("turn/start", { seq: i + 1 })); service.observe(status("failed", "HTTP 500")) }
    expect(await service.export()).toEqual({ exported: true, count: 1000 })
    expect(JSON.parse(await readFile(output, "utf8")).entries).toHaveLength(1000)
    expect((await stat(output)).size).toBeLessThanOrEqual(20 * 1024 * 1024)
  })
})
