import { expect, it } from "vitest"
import { birthFailure } from "../src/child/birth-outcome.ts"

it("keeps a blocked reservation in recovery with the outcome detail", () => {
  const error = birthFailure({ kind: "blocked", reason: "source-changed" }) as Error & { code?: string }
  expect(error.code).toBe("FACT_RECOVERY_REQUIRED")
  expect(error.message).toBe("Original child birth requires recovery (blocked: source-changed)")
})

it.each([
  [{ kind: "refused", reason: "target-policy" }, "refused: target-policy"],
  [{ kind: "refused", reason: "conflict" }, "refused: conflict"],
  [{ kind: "not-issued", reason: "cancelled" }, "not-issued: cancelled"],
  [{ kind: "not-issued", reason: "stale-source" }, "not-issued: stale-source"],
])("treats %o as an ordinary refusal", (outcome, detail) => {
  const error = birthFailure(outcome) as Error & { code?: string }
  expect(error.code).toBe("FACT_BIRTH_REFUSED")
  expect(error.message).toContain(detail)
  expect(error.message).not.toContain("requires recovery")
})

it("keeps an unsupported child birth as an ordinary refusal", () => {
  const error = birthFailure({ kind: "not-issued", reason: "unsupported" }) as Error & { code?: string }
  expect(error.code).toBe("FACT_BIRTH_REFUSED")
  expect(error.message).toBe("Original child birth was refused (not-issued: unsupported)")
})
