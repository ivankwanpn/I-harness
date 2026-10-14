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
