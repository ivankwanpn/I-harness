import { expect, it } from "vitest"
import { append, createSession, deriveContextRecovery, fromJSONL, toJSONL } from "../src/index.ts"

it("recovery fold retains retry consumption and progress facts through sparse transitions and JSONL reload", () => {
  const session = createSession()
  const base = { version: 1 as const, ownerSessionId: "parent", recoveryId: "recovery", logicalStepSeq: 7, bindingFingerprint: "a".repeat(64), rejectedInputFingerprint: "b".repeat(64) }
  append(session, { type: "context/recovery", ...base, state: "required", modelId: "m", protocol: "p", inputCost: 300, inputBytes: 1200, shapeFingerprint: "c".repeat(64) })
  append(session, { type: "context/recovery", ...base, state: "retry-started", retryInputFingerprint: "d".repeat(64) })
  append(session, { type: "context/recovery", ...base, state: "blocked" })
  const restored = fromJSONL(toJSONL(session))
  expect(deriveContextRecovery(restored, "parent")).toMatchObject({ state: "blocked", retryConsumed: true, inputCost: 300, inputBytes: 1200, shapeFingerprint: "c".repeat(64), retryInputFingerprint: "d".repeat(64) })
  expect(deriveContextRecovery(restored, "child")).toBeUndefined()
  expect(deriveContextRecovery(restored, "parent", { modelId: "different", protocol: "p" })).toBeUndefined()
})

it("a new model's resolution cannot erase an old model's unresolved rejection", () => {
  const session = createSession()
  const base = { version: 1 as const, ownerSessionId: "s", logicalStepSeq: 7, bindingFingerprint: "a".repeat(64), rejectedInputFingerprint: "b".repeat(64), protocol: "p" }
  append(session, { type: "context/recovery", ...base, recoveryId: "old", modelId: "old", state: "blocked", retryConsumed: true })
  append(session, { type: "context/recovery", ...base, recoveryId: "new", modelId: "new", state: "resolved" })
  expect(deriveContextRecovery(session, "s", { modelId: "old", protocol: "p" })).toMatchObject({ state: "blocked", retryConsumed: true })
  expect(deriveContextRecovery(session, "s", { modelId: "new", protocol: "p" })?.state).toBe("resolved")
})

it.each(["known-to-unknown", "unknown-to-known"] as const)("%s provider identity retains sparse recovery and consumed retry after JSONL reload", direction => {
  const session = createSession()
  const providerId = direction === "known-to-unknown" ? "configured-provider" : undefined
  const binding = { modelId: "m", protocol: "p", ...(direction === "unknown-to-known" ? { providerId: "configured-provider" } : {}) }
  const base = { version: 1 as const, ownerSessionId: "s", recoveryId: "r", logicalStepSeq: 7, bindingFingerprint: "a".repeat(64), rejectedInputFingerprint: "b".repeat(64) }
  append(session, { type: "context/recovery", ...base, state: "required", modelId: "m", protocol: "p", providerId, inputCost: 300 })
  append(session, { type: "context/recovery", ...base, state: "retry-started", retryInputFingerprint: "c".repeat(64) })
  append(session, { type: "context/recovery", ...base, state: "blocked" })
  for (const source of [session, fromJSONL(toJSONL(session))]) {
    expect(deriveContextRecovery(source, "s", binding)).toMatchObject({ recoveryId: "r", state: "blocked", retryConsumed: true, inputCost: 300 })
  }
})

it.each([
  { providerId: "other-provider", modelId: "m", protocol: "p" },
  { providerId: "configured-provider", modelId: "other-model", protocol: "p" },
  { providerId: "configured-provider", modelId: "m", protocol: "other-protocol" },
])("a concrete different tuple %j receives its own recovery lane", binding => {
  const session = createSession()
  append(session, { type: "context/recovery", version: 1, ownerSessionId: "s", recoveryId: "r", logicalStepSeq: 7, bindingFingerprint: "a".repeat(64), rejectedInputFingerprint: "b".repeat(64), state: "blocked", retryConsumed: true,
    providerId: "configured-provider", modelId: "m", protocol: "p" })
  expect(deriveContextRecovery(fromJSONL(toJSONL(session)), "s", binding)).toBeUndefined()
})

it("unknown provider identity cannot let a different provider's resolution hide an applicable rejection", () => {
  const session = createSession()
  const base = { version: 1 as const, ownerSessionId: "s", logicalStepSeq: 7, bindingFingerprint: "a".repeat(64), rejectedInputFingerprint: "b".repeat(64), modelId: "m", protocol: "p" }
  append(session, { type: "context/recovery", ...base, recoveryId: "first", providerId: "first-provider", state: "blocked", retryConsumed: true })
  append(session, { type: "context/recovery", ...base, recoveryId: "second", providerId: "second-provider", state: "retry-started" })
  append(session, { type: "context/recovery", ...base, recoveryId: "second", state: "resolved" })
  const restored = fromJSONL(toJSONL(session))
  expect(deriveContextRecovery(restored, "s", { modelId: "m", protocol: "p" })).toMatchObject({ recoveryId: "first", state: "blocked", retryConsumed: true })
  expect(deriveContextRecovery(restored, "s", { providerId: "second-provider", modelId: "m", protocol: "p" })).toMatchObject({ recoveryId: "second", state: "resolved" })
  expect(deriveContextRecovery(restored, "s")?.state).toBe("resolved")
})
