import { expect, it, vi } from "vitest"
import { createSessionService } from "../src/index.ts"
import { mkdtempSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createTelemetry, createJsonlSink, type TelemetryEvent } from "@i-harness/telemetry"
import { createBedrockClient, type BedrockRuntimeFace } from "../../llm-bedrock/src/index.ts"
import { modelFailureFacts } from "@i-harness/llm-seam"
import { rmWorkspaceSync } from "./helpers.ts"

it.each(["context", "unknown"] as const)("actual submit keeps %s SDK error text out of every failure event and the JSONL sink", async kind => {
  const workspace = mkdtempSync(join(tmpdir(), "ih-safe-submit-telemetry-"))
  const privateText = "private-provider-prompt-9182 sensitive-provider-credential-9182"
  const upstream = kind === "context"
    ? Object.assign(new Error(`The input length exceeds the maximum context length. ${privateText}`), { name: "ValidationException", $metadata: { httpStatusCode: 400, requestId: "aws-123" } })
    : new Error(privateText)
  const events: TelemetryEvent[] = [], lines: string[] = []
  const stream = { write(line: string) { lines.push(line); return true } } as NodeJS.WritableStream
  const telemetry = createTelemetry([{ onEvent(event) { events.push(event) } }, createJsonlSink(stream)])
  const runtime = { send: vi.fn(async () => ({ stream: [{ contentBlockDelta: { contentBlockIndex: 0, delta: { text: "accepted again" } } }, { messageStop: { stopReason: "end_turn" } }] })).mockRejectedValueOnce(upstream), destroy() {} }
  const model = createBedrockClient({ model: "fixture", region: "us-east-1" }, runtime as unknown as BedrockRuntimeFace)
  const service = createSessionService({ workspace, model, telemetry })
  try {
    const assembly = await service.assemblyFor("s")
    const error = await service.submit("s", "fixture", new AbortController().signal).catch(error => error)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain(privateText)
    expect(error.cause.cause).toBe(upstream)
    const failures = events.filter(event => event.type === "error" || event.type.endsWith("/error"))
    expect(failures.map(event => event.type)).toEqual(["provider/error", "session/error"])
    expect(JSON.stringify(failures) + lines.join("")).not.toMatch(/private-provider-prompt-9182|sensitive-provider-credential-9182/)
    const sessionError = failures.find(event => event.type === "session/error")!
    if (kind === "context") {
      expect(sessionError.data).toMatchObject({ sessionId: "s", error: "Model input exceeds the context window.", modelFailure: { code: "CONTEXT_WINDOW_EXCEEDED", httpStatus: 400, providerType: "ValidationException", requestId: "aws-123", message: "Model input exceeds the context window." } })
      expect(modelFailureFacts(error)?.code).toBe("CONTEXT_WINDOW_EXCEEDED")
    } else {
      expect(sessionError.data).toEqual({ sessionId: "s", error: "Session execution failed." })
      expect(modelFailureFacts(error)).toBeUndefined()
    }
    expect(lines.map(line => JSON.parse(line)).filter(event => event.type === "session/error")).toEqual([sessionError])
    expect(service.liveAssembly("s")).toBe(assembly)
    await expect(service.submit("s", "next", new AbortController().signal)).resolves.toBeUndefined()
    expect(runtime.send).toHaveBeenCalledTimes(2)
    expect(service.liveAssembly("s")).toBe(assembly)
  } finally { await service.close(); rmWorkspaceSync(workspace) }
})

it("assembly rejection retains the original error while all session failure telemetry stays generic", async () => {
  const privateText = "private-assembly-prompt-9182 sensitive-assembly-credential-9182"
  const upstream = new Error(privateText)
  const events: TelemetryEvent[] = [], lines: string[] = []
  const telemetry = createTelemetry([{ onEvent(event) { events.push(event) } }, createJsonlSink({ write(line: string) { lines.push(line); return true } } as NodeJS.WritableStream)])
  const service = createSessionService({ workspace: process.cwd(), telemetry, modelBindingFor: async () => { throw upstream } })
  try {
    await expect(service.submit("s", "fixture", new AbortController().signal)).rejects.toBe(upstream)
    const failures = events.filter(event => event.type === "error" || event.type.endsWith("/error"))
    expect(failures).toMatchObject([{ type: "session/error", data: { sessionId: "s", error: "Session execution failed." } }])
    expect(failures).toHaveLength(1)
    expect(JSON.stringify(failures) + lines.join("")).not.toMatch(/private-assembly-prompt-9182|sensitive-assembly-credential-9182/)
  } finally { await service.close() }
})
it("retries non-ready bindings after configuration changes but keeps ready bindings stable", async () => {
  let configured = false
  const resolve = vi.fn(async () => configured
    ? { status: "ready" as const, binding: { providerId: "p", modelId: "m", label: "ready", model: { async *stream() {} } } }
    : { status: "unconfigured" as const, reason: "missing key" })
  const service = createSessionService({ workspace: process.cwd(), modelBindingFor: resolve })
  try {
    expect(await service.modelState("s")).toMatchObject({ status: "unconfigured" })
    configured = true
    expect(await service.modelState("s")).toMatchObject({ status: "ready", modelId: "m" })
    expect(await service.modelState("s")).toMatchObject({ status: "ready", modelId: "m" })
    expect(resolve).toHaveBeenCalledTimes(2)
  } finally { await service.close() }
})
