import { afterEach, expect, it, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createContext } from "../../core-plugin/src/index.ts"
import { createSession } from "../../core-session/src/index.ts"
import { createToolRegistry } from "../../core-tools/src/index.ts"
import { createAgent } from "../../core-agent/src/index.ts"
import { createOpenAIClient } from "../../llm-openai/src/index.ts"
import { createRetryingClient, resolveRetryPolicy } from "../../llm-seam/src/index.ts"
import { RpcError } from "@i-harness/sdk"
import { createRuntimeDiagnostics } from "../src/main/runtime-diagnostics.ts"

const roots: string[] = []
afterEach(async () => { vi.unstubAllGlobals(); for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }) })
const capacity = "Selected model is at capacity. Please try a different model."
it.each([
  [{ type: "error", code: "server_is_overloaded", message: "PRIVATE_UPSTREAM_TEXT" }, "CAPACITY"],
  [{ type: "response.failed", response: { error: { code: "server_overloaded", message: capacity } } }, "CAPACITY"],
  [{ type: "error", message: capacity }, "CAPACITY"],
  [{ type: "error", code: "invalid_request_error", message: capacity }, "model_error"],
  [{ type: "error", message: `Unrelated payload: ${capacity}` }, "model_error"],
] as const)("retains terminal stream capacity identity across message-only SDK status: %j", async (wire, code) => {
  const directory = await mkdtemp(join(tmpdir(), "ih-capacity-diagnostic-")); roots.push(directory)
  const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx)
  const fetch = vi.fn(async () => new Response(`data: ${JSON.stringify(wire)}\n\n`)); vi.stubGlobal("fetch", fetch)
  const model = createRetryingClient(createOpenAIClient({ apiKey: "fixture", model: "fixture", baseUrl: "https://fixture.invalid" }), resolveRetryPolicy({ mode: "normal", maxRetries: 0 }))
  const error = await createAgent(ctx, { session, tools, model, systemPrompt: "" }).run("fixture").then(() => { throw new Error("expected terminal failure") }, error => error as Error)
  expect(fetch).toHaveBeenCalledTimes(1)
  for (const first of ["status", "rpc"]) {
    const diagnostics = createRuntimeDiagnostics(join(directory, first))
    const status = () => diagnostics.observe({ kind: "sdk/notification", workspaceId: "w", method: "session/status", params: { sessionId: "s", status: "failed", error: error.message } })
    const rejection = () => diagnostics.recordRequestFailure("w", "s", new RpcError(-32603, error.message))
    if (first === "status") { status(); rejection() } else { rejection(); status() }
    const { entries } = await diagnostics.list()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ kind: "session/error", code })
    if (code === "CAPACITY") expect(entries[0]?.message).toContain("temporarily at capacity")
    expect(JSON.stringify(entries)).not.toContain("PRIVATE_UPSTREAM_TEXT")
  }
})
