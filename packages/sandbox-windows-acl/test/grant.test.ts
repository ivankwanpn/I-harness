import { describe, expect, it } from "vitest"
import { AclWriteGrant } from "../src/grant.ts"

describe("AclWriteGrant", () => {
  it("create parses the SID string (win32-only)", () => {
    if (process.platform !== "win32") return
    const grant = AclWriteGrant.create("S-1-4-1-2")
    expect(grant.writeSid).toBe("S-1-4-1-2")
    grant.dispose()
  })
})
