import { expect, it } from "vitest"
import { append, createSession, fromJSONL, toJSONL, validContextEvent, type RequestBudgetSnapshot } from "../src/index.ts"

const identity = { version: 1 as const, semanticRevision: "a".repeat(64), protectionRevision: "b".repeat(64), branchId: "c".repeat(64), contextEpoch: "d".repeat(64), surfaceRevision: "e".repeat(64) }
const snapshot: RequestBudgetSnapshot = { version: 1, ownerSessionId: "owner", modelId: "m", protocol: "p", bindingFingerprint: "f".repeat(64), bindingRevision: 0, projectionRevision: 0, neutralFingerprint: "1".repeat(64), identityCoverage: "partial",
  estimatedInputTokens: 10, admissionInputTokens: 10, estimateSource: "neutral-only", coverage: "neutral-only", confidence: "estimated", roleTokens: { user: 10, assistant: 0, tool: 0 }, systemTokens: 0, schemaTokens: 0, reasoningTokens: 0,
  outputReserve: 0, capSupport: "unknown", safetyMargin: 0, admission: "unavailable", recoveryRequired: false, fullByProvider: false }
const event = (extra: object) => ({ type: "context/budget", version: 1, snapshot: { ...snapshot, ...extra } })

it("roundtrips strict scalar request identity and preserves legacy facts", () => {
  const session = createSession()
  append(session, { type: "context/budget", version: 1, snapshot })
  append(session, { type: "context/budget", version: 1, snapshot: { ...snapshot, requestContext: identity, postResponseContextRevision: "2".repeat(64) } })
  expect(fromJSONL(toJSONL(session)).events).toEqual(session.events)
})
it.each([
  { requestContext: { ...identity, extra: "payload" } }, { requestContext: { version: 1, semanticRevision: identity.semanticRevision } },
  { requestContext: { ...identity, surfaceRevision: "A".repeat(64) } }, { postResponseContextRevision: "2".repeat(64) },
  { requestContext: identity, postResponseContextRevision: "bad" }, { requestContext: identity, reason: "large".repeat(1000) },
])("rejects malformed or oversized identity %#", extra => {
  expect(validContextEvent(event(extra))).toBe(false)
})
