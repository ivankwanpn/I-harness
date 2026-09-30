import { expect, it, vi } from "vitest"
import { createSession } from "@i-harness/core-session"
import { createContext } from "@i-harness/core-plugin"
import type { ApprovalGuardian } from "@i-harness/core-tools"
import type { ModelClient } from "@i-harness/llm-seam"
import { registerGuardian, createIsolatedReviewerPool, type GuardianConfig, type GuardianReviewDeps, type GuardianReviewRecord } from "../src/guardian/index.ts"
import { runIsolatedGuardianReview } from "../src/guardian/isolated-reviewer.ts"

const request = { name: "read", args: { path: "sample.txt" }, reason: "delegate" }
function deps(model: ModelClient): GuardianReviewDeps {
  // The isolated path must not touch any of these general Agent dependencies.
  return { parentModel: model, parentSession: createSession(), resolveModel: async () => { throw new Error("unused") } } as unknown as GuardianReviewDeps
}
it("does not review a silently truncated tool argument", async () => {
  const stream = vi.fn(async function* () {
    yield { type: "text/chunk" as const, text: '{"outcome":"approve","rationale":"safe","risk_level":"none"}' }
    yield { type: "end" as const }
  })
  const verdict = await runIsolatedGuardianReview(deps({ stream }), { ...request, args: { command: "x".repeat(4001) } })
  expect(verdict).toMatchObject({ outcome: "deny", cause: "operational" })
  expect(stream).not.toHaveBeenCalled()
})
it("aborts a pending model request without falling back to a human approval", async () => {
  let signal: AbortSignal | undefined
  const model: ModelClient = { async *stream(input) {
    signal = input.signal
    await new Promise<void>((resolve) => input.signal!.addEventListener("abort", () => resolve(), { once: true }))
  } }
  const ctx = createContext()
  await registerGuardian(ctx, { ...deps(model), execution: "isolated", fallbackToHumanOnFailure: true })
  const controller = new AbortController()
  const review = ctx.services.get<ApprovalGuardian>("approval/guardian")({ ...request, signal: controller.signal })
  controller.abort(new Error("user stopped"))
  await expect(review).rejects.toThrow("user stopped")
  expect(signal?.aborted).toBe(true)
})
it("times out and defers to the human instead of hanging the parent", async () => {
  vi.useFakeTimers()
  try {
    let signal: AbortSignal | undefined
    const model: ModelClient = { async *stream(input) {
      signal = input.signal
      await new Promise<void>((resolve) => input.signal!.addEventListener("abort", () => resolve(), { once: true }))
    } }
    const ctx = createContext()
    await registerGuardian(ctx, { ...deps(model), execution: "isolated", fallbackToHumanOnFailure: true, timeoutMs: 20 })
    const review = ctx.services.get<ApprovalGuardian>("approval/guardian")(request)
    await vi.advanceTimersByTimeAsync(20)
    expect(await review).toMatchObject({ outcome: "allow" })
    expect(signal?.aborted).toBe(true)
  } finally { vi.useRealTimers() }
})
it("rejects tool calls and incomplete verdicts from the reviewer", async () => {
  for (const event of [{ type: "tool_call" as const, call: { name: "bash", args: {} } }, { type: "end" as const, truncated: true as const }]) {
    const model: ModelClient = { async *stream() {
      yield { type: "text/chunk", text: '{"outcome":"approve","rationale":"safe","risk_level":"none"}' }
      yield event
    } }
    expect(await runIsolatedGuardianReview(deps(model), request)).toMatchObject({ outcome: "deny" })
  }
})

const approval = '{"outcome":"approve","rationale":"safe","risk_level":"none"}'
const rejection = '{"outcome":"deny","rationale":"different action","risk_level":"high"}'
function reusable(model: ModelClient) {
  const identity = { provider: "cheap", model: "small", protocol: "openai-completions", reasoningEffort: "low", configurationKey: "route-v1" }
  let permission = "workspace-one:delegate:restricted"
  const config = { ...deps(model), isolated: { identity: () => ({ ...identity }), permissionContext: () => permission } } as GuardianReviewDeps & {
    isolated: { identity(): typeof identity; permissionContext(): string }
  }
  return { config, identity, permission: (value: string) => { permission = value } }
}
it("reuses a bounded tool-free conversation but reviews every changed action afresh", async () => {
  const seen: Parameters<ModelClient["stream"]>[0][] = []
  const model: ModelClient = { async *stream(input) {
    seen.push(input)
    yield { type: "text/chunk", text: seen.length === 1 ? approval : rejection }
    yield { type: "end" }
  } }
  const { config } = reusable(model)
  expect(await runIsolatedGuardianReview(config, request)).toMatchObject({ outcome: "approve" })
  expect(await runIsolatedGuardianReview(config, { ...request, args: { path: "danger.txt" } })).toMatchObject({ outcome: "deny" })
  expect(seen).toHaveLength(2)
  expect(seen[1]!.messages).toHaveLength(3)
  expect(seen[1]!.messages[1]).toMatchObject({ role: "assistant", content: approval })
  expect(seen[1]!.messages[2]!.content).toContain("danger.txt")
  expect(seen.every((input) => input.tools.length === 0)).toBe(true)
})
it("isolates reused conversations by effective model, policy, permission and user intent", async () => {
  const lengths: number[] = []
  const model: ModelClient = { async *stream(input) { lengths.push(input.messages.length); yield { type: "text/chunk", text: approval }; yield { type: "end" } } }
  const state = reusable(model)
  const review = () => runIsolatedGuardianReview(state.config, request)
  await review(); await review()
  for (const field of ["provider", "model", "protocol", "reasoningEffort", "configurationKey"] as const) { state.identity[field] += "-changed"; await review() }
  state.permission("workspace-two:delegate:restricted"); await review()
  state.config.policyText = "A changed policy"; await review()
  state.config.parentSession.events.push({ type: "user/message", text: "A different task", seq: 0 }); await review()
  expect(lengths).toEqual([1, 3, 1, 1, 1, 1, 1, 1, 1, 1])
})
it("rolls back malformed and operational reviews instead of poisoning reusable context", async () => {
  const seen: Parameters<ModelClient["stream"]>[0][] = []
  const model: ModelClient = { async *stream(input) {
    seen.push(input)
    if (seen.length === 3) throw new Error("network down")
    yield { type: "text/chunk", text: seen.length === 2 ? "malformed" : approval }; yield { type: "end" }
  } }
  const { config } = reusable(model)
  await runIsolatedGuardianReview(config, request)
  expect(await runIsolatedGuardianReview(config, { ...request, args: { path: "bad-one" } })).toMatchObject({ cause: "malformed" })
  expect(await runIsolatedGuardianReview(config, { ...request, args: { path: "bad-two" } })).toMatchObject({ cause: "operational" })
  await runIsolatedGuardianReview(config, request)
  expect(seen.map((input) => input.messages.length)).toEqual([1, 3, 3, 3])
  expect(JSON.stringify(seen[3]!.messages)).not.toContain("bad-one")
  expect(JSON.stringify(seen[3]!.messages)).not.toContain("bad-two")
})
it("records actual requests, model identity and the effective human fallback", async () => {
  const records: unknown[] = []
  const model: ModelClient = { async *stream() { yield { type: "text/chunk", text: "invalid verdict" }; yield { type: "end" } } }
  const { config } = reusable(model)
  const ctx = createContext()
  await registerGuardian(ctx, { ...config, execution: "isolated", fallbackToHumanOnFailure: true,
    isolated: { ...config.isolated, onReview: (record: unknown) => { records.push(record) } } } as GuardianConfig)
  expect(await ctx.services.get<ApprovalGuardian>("approval/guardian")(request)).toMatchObject({ outcome: "allow" })
  expect(records).toEqual([expect.objectContaining({ status: "malformed", outcome: "allow", reviewerOutcome: "deny", durationMs: expect.any(Number),
    request: expect.objectContaining({ name: "read", args: '{"path":"sample.txt"}' }),
    model: expect.objectContaining({ provider: "cheap", model: "small", protocol: "openai-completions", reasoningEffort: "low" }) })])
})
it("does not reuse a conversation from a different parent session", async () => {
  const lengths: number[] = []
  const model: ModelClient = { async *stream(input) { lengths.push(input.messages.length); yield { type: "text/chunk", text: approval }; yield { type: "end" } } }
  const { config } = reusable(model)
  const pool = createIsolatedReviewerPool()
  const first = { ...config, isolated: { ...config.isolated, pool } }
  await runIsolatedGuardianReview(first, request)
  await runIsolatedGuardianReview({ ...first, parentSession: createSession() }, request)
  expect(lengths).toEqual([1, 1])
})
it("sends the effective inherited effort and records it", async () => {
  let effort: unknown
  const model: ModelClient = { async *stream(input) { effort = input.reasoningEffort; yield { type: "text/chunk", text: approval }; yield { type: "end" } } }
  await runIsolatedGuardianReview(reusable(model).config, request)
  expect(effort).toBe("low")
})
it("bounds the number and size of reusable contexts", async () => {
  const seen: Parameters<ModelClient["stream"]>[0][] = []
  const model: ModelClient = { async *stream(input) { seen.push(input); yield { type: "text/chunk", text: approval }; yield { type: "end" } } }
  const state = reusable(model)
  const config = { ...state.config, isolated: { ...state.config.isolated, pool: createIsolatedReviewerPool({ maxContexts: 2, maxTurns: 2, maxContextChars: 4000 }) } }
  for (let index = 0; index < 8; index++) await runIsolatedGuardianReview(config, request)
  expect(seen.every((input) => input.messages.length <= 5 && JSON.stringify(input.messages).length < 6000)).toBe(true)
  state.identity.model = "second"; await runIsolatedGuardianReview(config, request)
  state.identity.model = "third"; await runIsolatedGuardianReview(config, request)
  state.identity.model = "small"; await runIsolatedGuardianReview(config, request)
  expect(seen.at(-1)!.messages).toHaveLength(1)
})
it("rolls back a timeout or cancellation and records cancellation without a human fallback", async () => {
  vi.useFakeTimers()
  try {
    const seen: Parameters<ModelClient["stream"]>[0][] = []
    const model: ModelClient = { async *stream(input) {
      seen.push(input)
      if (seen.length === 2 || seen.length === 3) await new Promise<void>((resolve) => input.signal!.addEventListener("abort", () => resolve(), { once: true }))
      yield { type: "text/chunk", text: approval }; yield { type: "end" }
    } }
    const state = reusable(model)
    const records: GuardianReviewRecord[] = []
    const ctx = createContext()
    await registerGuardian(ctx, { ...state.config, execution: "isolated", timeoutMs: 20, fallbackToHumanOnFailure: true, isolated: { ...state.config.isolated, onReview: (record) => { records.push(record) } } })
    const review = ctx.services.get<ApprovalGuardian>("approval/guardian")
    await review(request)
    const timed = review({ ...request, args: { path: "timed-out" } })
    await vi.advanceTimersByTimeAsync(20)
    expect(await timed).toMatchObject({ outcome: "allow" })
    const controller = new AbortController()
    const cancelled = review({ ...request, args: { path: "cancelled" }, signal: controller.signal })
    const rejected = expect(cancelled).rejects.toThrow("stopped")
    await vi.advanceTimersByTimeAsync(1)
    controller.abort(new Error("stopped")); await rejected
    await review(request)
    expect(seen.map((input) => input.messages.length)).toEqual([1, 3, 3, 3])
    expect(JSON.stringify(seen[3]!.messages)).not.toContain("timed-out")
    expect(JSON.stringify(seen[3]!.messages)).not.toContain("cancelled")
    expect(records.map((record) => record.status)).toEqual(["completed", "timeout", "cancelled", "completed"])
    expect(records[2]).not.toHaveProperty("outcome")
  } finally { vi.useRealTimers() }
})
it("keeps concurrent reviews isolated and does not commit a busy-context one-shot", async () => {
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const seen: Parameters<ModelClient["stream"]>[0][] = []
  const model: ModelClient = { async *stream(input) { seen.push(input); if (seen.length === 1) await held; yield { type: "text/chunk", text: approval }; yield { type: "end" } } }
  const { config } = reusable(model)
  const first = runIsolatedGuardianReview(config, request)
  await Promise.resolve(); await Promise.resolve()
  await runIsolatedGuardianReview(config, { ...request, args: { path: "concurrent" } })
  release(); await first
  await runIsolatedGuardianReview(config, request)
  expect(seen.map((input) => input.messages.length)).toEqual([1, 1, 3])
  expect(JSON.stringify(seen[2]!.messages)).not.toContain("concurrent")
})
it("uses an atomically resolved client and identity instead of a mutable parent model handle", async () => {
  const parent = vi.fn(async function* () { throw new Error("mutable parent must not be used") })
  const seen: Parameters<ModelClient["stream"]>[0][] = []
  const client: ModelClient = { async *stream(input) { seen.push(input); yield { type: "text/chunk", text: approval }; yield { type: "end" } } }
  const state = reusable({ stream: parent })
  const resolveBinding = vi.fn(async () => ({ client, identity: { ...state.identity }, reasoningEffort: "low" as const, contextWindow: 100000, maxOutputTokens: 8192 }))
  const config = { ...state.config, isolated: { permissionContext: state.config.isolated.permissionContext, resolveBinding } }
  expect(await runIsolatedGuardianReview(config, request)).toMatchObject({ outcome: "approve" })
  expect(await runIsolatedGuardianReview(config, request)).toMatchObject({ outcome: "approve" })
  state.identity.protocol = "anthropic-messages"
  expect(await runIsolatedGuardianReview(config, request)).toMatchObject({ outcome: "approve" })
  expect(parent).not.toHaveBeenCalled()
  expect(resolveBinding).toHaveBeenCalledTimes(3)
  expect(seen[1]!.messages).toHaveLength(3)
  expect(seen[2]!.messages).toHaveLength(1)
})
it("never reuses a context when the effective model configuration is unavailable", async () => {
  const lengths: number[] = []
  const model: ModelClient = { async *stream(input) { lengths.push(input.messages.length); yield { type: "text/chunk", text: approval }; yield { type: "end" } } }
  const { config } = reusable(model)
  config.isolated.identity = () => ({ provider: "cheap", model: "small", protocol: "openai-completions", reasoningEffort: "low", configurationKey: "" })
  await runIsolatedGuardianReview(config, request); await runIsolatedGuardianReview(config, request)
  expect(lengths).toEqual([1, 1])
})
it("requires a complete stream ending before committing a valid-looking verdict", async () => {
  const lengths: number[] = []
  const model: ModelClient = { async *stream(input) { lengths.push(input.messages.length); yield { type: "text/chunk", text: approval }; if (lengths.length > 1) yield { type: "end" } } }
  const { config } = reusable(model)
  expect(await runIsolatedGuardianReview(config, request)).toMatchObject({ cause: "malformed" })
  expect(await runIsolatedGuardianReview(config, request)).toMatchObject({ outcome: "approve" })
  expect(lengths).toEqual([1, 1])
})
it("reuses only final text and never private reasoning or provider continuation metadata", async () => {
  const seen: Parameters<ModelClient["stream"]>[0][] = []
  const model: ModelClient = { async *stream(input) {
    seen.push(input)
    yield { type: "reasoning", text: "private reviewer deliberation", blockId: "private" }
    yield { type: "text/chunk", text: approval }
    yield { type: "end", providerContinuation: { kind: "openai-responses", reasoningItems: [{ id: "private-response", type: "reasoning" }] } }
  } }
  const { config } = reusable(model)
  await runIsolatedGuardianReview(config, request); await runIsolatedGuardianReview(config, request)
  expect(seen[1]!.messages).toHaveLength(3)
  expect(seen[1]!.messages[1]).toEqual({ role: "assistant", content: approval })
  expect(JSON.stringify(seen[1]!.messages)).not.toContain("private")
})
