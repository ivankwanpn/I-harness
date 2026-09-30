import { expect, it, vi } from "vitest"
import { createSession } from "@i-harness/core-session"
import { createContext } from "@i-harness/core-plugin"
import type { ApprovalGuardian } from "@i-harness/core-tools"
import type { ModelClient } from "@i-harness/llm-seam"
import { registerGuardian, type GuardianReviewDeps } from "../src/guardian/index.ts"
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
