import { expect, it } from "vitest"
import { resolveUnissuedConflict } from "../src/coordinator/unissued-conflict.ts"
import type { BackendFactOutcome } from "../src/coordinator/fact-types.ts"

const key = { sessionId: "s", firstSeq: 3, count: 1, previousPrefixDigest: "a".repeat(64), batchDigest: "b".repeat(64) } as never

it("turns a conflict on an unissued batch into a provable absence", () => {
  expect(resolveUnissuedConflict({ kind: "conflict", key }, false)).toEqual({ kind: "absent", key })
  expect(resolveUnissuedConflict({ kind: "unknown", key }, false)).toEqual({ kind: "absent", key })
})

it("keeps the fail-closed outcome for an issued batch", () => {
  expect(resolveUnissuedConflict({ kind: "conflict", key }, true)).toEqual({ kind: "conflict", key })
  expect(resolveUnissuedConflict({ kind: "unknown", key }, true)).toEqual({ kind: "unknown", key })
})

it("never rewrites a settled or committed outcome", () => {
  const committed: BackendFactOutcome = { kind: "committed", receipt: {} as never }
  expect(resolveUnissuedConflict(committed, false)).toBe(committed)
  expect(resolveUnissuedConflict({ kind: "absent", key }, false)).toEqual({ kind: "absent", key })
})
