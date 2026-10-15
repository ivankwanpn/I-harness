// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import type { RequestBudgetSnapshot } from "../../core-session/src/index.ts"
import { createRuntimeDiagnostics } from "../src/main/runtime-diagnostics.ts"
import { RuntimeFeedback } from "../src/renderer/session/RuntimeFeedback.tsx"
import { useUiStore } from "../src/renderer/shell/ui-store.ts"
import type { DesktopBridge, DesktopEvent } from "../src/shared/bridge.ts"

const fixtures: { directory: string; diagnostics: ReturnType<typeof createRuntimeDiagnostics>; unsubscribe(): void }[] = []
afterEach(async () => {
  cleanup()
  localStorage.clear()
  useUiStore.setState({ draftSubmissionScope: undefined })
  for (const fixture of fixtures.splice(0)) {
    fixture.unsubscribe()
    await fixture.diagnostics.flush()
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

const budget: RequestBudgetSnapshot = {
  version: 1, ownerSessionId: "a", modelId: "controlled", protocol: "anthropic-messages",
  bindingFingerprint: "a".repeat(64), neutralFingerprint: "b".repeat(64), identityCoverage: "complete",
  bindingRevision: 0, projectionRevision: 0, estimatedInputTokens: 147617, admissionInputTokens: 147617,
  contextWindow: 1000000, outputReserve: 384000, effectiveOutputCap: 384000, safetyMargin: 100000,
  estimateSource: "provider-anchor-plus-projection", confidence: "calibrated-mixed", coverage: "complete",
  roleTokens: { user: 144617, assistant: 0, tool: 0 }, systemTokens: 1000, schemaTokens: 2000, reasoningTokens: 0,
  capSupport: "supported", admission: "unavailable", recoveryRequired: false, fullByProvider: false,
  reason: "Accepted output awaits the next protocol projection",
}
const sessionEvent = (event: Record<string, unknown>, sessionId = "a"): DesktopEvent => ({
  kind: "sdk/notification", workspaceId: "w", method: "session/event", params: { sessionId, event },
})
const cases: { label: string; kind: string; event: DesktopEvent }[] = [
  { label: "post-response budget", kind: "context/budget", event: sessionEvent({ type: "context/budget", version: 1, seq: 1, snapshot: budget }) },
  { label: "physical request metrics", kind: "context/request", event: {
    kind: "sdk/notification", workspaceId: "w", method: "desktop/context/diagnostic", params: { id: "metrics", sessionId: "a", requestMetrics: {
      version: 1, coverage: "complete", capSupport: "supported", sizeKind: "http-json-body", bodyBytes: 200000,
      inlineBinaryBytes: 0, cacheMetadataBytes: 0, signatureBytes: 0, systemTokens: 1000, schemaTokens: 2000,
      reasoningTokens: 0, imageCount: 0, minimumOutputCap: 1,
    } },
  } },
  ...(["success", "failure"] as const).map(outcome => ({ label: `${outcome} compaction diagnostics`, kind: "context/compaction", event: {
    kind: "sdk/notification", workspaceId: "w", method: "desktop/context/diagnostic", params: { sessionId: "a", compaction: { operation: "attempt", outcome, attempts: 1 } },
  } satisfies DesktopEvent })),
]

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "ih-feedback-diagnostics-"))
  const diagnostics = createRuntimeDiagnostics(directory)
  const listeners = new Set<(event: DesktopEvent) => void>()
  const deliver = (event: DesktopEvent) => listeners.forEach(listener => listener(event))
  const unsubscribeEntry = diagnostics.onEntry(entry => deliver({ kind: "runtime/diagnostic", entry }))
  const unsubscribeActivity = diagnostics.onActivity(activity => deliver({ kind: "runtime/activity", ...activity }))
  const bridge: DesktopBridge = { request: vi.fn(async () => diagnostics.list()), onEvent(listener) { listeners.add(listener); return () => { listeners.delete(listener) } } }
  const observe = (event: DesktopEvent) => act(() => { diagnostics.observe(event); deliver(event) })
  fixtures.push({ directory, diagnostics, unsubscribe: () => { unsubscribeEntry(); unsubscribeActivity() } })
  return { directory, diagnostics, bridge, observe }
}

it.each(cases)("journals native $label without a request-failure popup", async ({ kind, event }) => {
  const f = await fixture()
  render(<RuntimeFeedback bridge={f.bridge} workspaceId="w" sessionId="a" onOpenLog={() => {}} />)
  f.observe(event)
  await f.diagnostics.flush()
  const restored = await createRuntimeDiagnostics(f.directory).list()
  expect(restored.entries).toHaveLength(1)
  expect(restored.entries[0]).toMatchObject({ kind, level: "info", workspaceId: "w", sessionId: "a" })
  expect(screen.queryByRole("alert")).toBeNull()
  expect(screen.queryByRole("status")).toBeNull()
})

it("keeps native diagnostics from replacing a genuine failure or creating a background-chat popup", async () => {
  const f = await fixture()
  const props = { bridge: f.bridge, workspaceId: "w", sessionId: "a", onOpenLog() {} }
  const view = render(<RuntimeFeedback {...props} />)
  act(() => f.diagnostics.recordRequestFailure("w", "a", new Error("HTTP 503")))
  const failure = screen.getByRole("alert").textContent
  expect(failure).toContain("HTTP 503")
  for (const { event } of cases) f.observe(event)
  expect(screen.getByRole("alert").textContent).toBe(failure)
  f.observe(sessionEvent({ type: "context/budget", version: 1, seq: 1, snapshot: { ...budget, ownerSessionId: "b" } }, "b"))
  view.rerender(<RuntimeFeedback {...props} sessionId="b" />)
  expect(screen.queryByRole("alert")).toBeNull()
  view.rerender(<RuntimeFeedback {...props} />)
  expect(screen.getByRole("alert").textContent).toBe(failure)
})

it("preserves native retry and quiet feedback while context bookkeeping arrives", async () => {
  const f = await fixture()
  render(<RuntimeFeedback bridge={f.bridge} workspaceId="w" sessionId="a" onOpenLog={() => {}} />)
  for (const phase of ["connecting", "quiet"] as const) f.observe(sessionEvent({ type: "model/activity", version: 1, activity: {
    requestId: "physical", phase, startedAt: Date.now() - 20000, waitingFor: "progress",
  } }))
  const retry = { requestId: "logical", phase: "waiting", attempt: 1, maxRetries: 5, delayMs: 10000, nextAttemptAt: Date.now() + 10000, code: "CAPACITY" }
  f.observe(sessionEvent({ type: "model/retry", version: 1, retry }))
  for (const { event } of cases) f.observe(event)
  expect(screen.getByRole("status").textContent).toContain("容量")
  expect(screen.queryByRole("alert")).toBeNull()
  f.observe(sessionEvent({ type: "model/retry", version: 1, retry: { ...retry, phase: "recovered" } }))
  expect(screen.getByRole("status").textContent).toContain("等待模型繼續")
  expect(screen.queryByRole("alert")).toBeNull()
  act(() => f.diagnostics.recordRequestFailure("w", "a", new Error("HTTP 401")))
  expect(screen.getByRole("alert").textContent).toContain("HTTP 401")
  expect(screen.queryByRole("status")).toBeNull()
})
