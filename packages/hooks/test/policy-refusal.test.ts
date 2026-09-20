import { describe, expect, it } from "vitest"
import { isPolicyRefusal } from "@i-harness/core-tools"
import { HookBlockedError } from "../src/types.ts"

// spec §2.6: a POLICY refusal — "you may not do this" — must be
// distinguishable from a tool body that tried and failed. The distinction is
// a NAMED MARKER on the error, not a list of class names: a future in-cascade
// policy opts in by carrying it, and `core-agent` needs no dependency on the
// mechanism that refuses.
describe("isPolicyRefusal", () => {
  it("recognises a hook veto", () => {
    expect(isPolicyRefusal(new HookBlockedError("h1", "read disabled"))).toBe(true)
  })

  it("does NOT claim an ordinary tool-body failure", () => {
    expect(isPolicyRefusal(new Error("disk exploded"))).toBe(false)
  })

  it("is total — a non-error never throws", () => {
    for (const v of [undefined, null, 0, "", "boom", {}, [], () => {}]) {
      expect(() => isPolicyRefusal(v)).not.toThrow()
      expect(isPolicyRefusal(v)).toBe(false)
    }
  })

  it("requires the marker to be TRUE, not merely present", () => {
    // The same rule this branch ruled on before (W4's F1): the decision keys
    // on a field CARRYING a value, not on the key existing.
    expect(isPolicyRefusal({ policyRefusal: undefined })).toBe(false)
    expect(isPolicyRefusal({ policyRefusal: false })).toBe(false)
    expect(isPolicyRefusal({ policyRefusal: true })).toBe(true)
  })
})
