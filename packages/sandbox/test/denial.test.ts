import { describe, expect, it } from "vitest"
import { denialFor } from "../src/denial.ts"

describe("denialFor", () => {
  it("names the surface, the mode, and how to ask for more", () => {
    const d = denialFor("fs", "read-only", "refusing to modify /etc/hosts")
    expect(d.code).toBe("SANDBOX_DENIED")
    expect(d.surface).toBe("fs")
    expect(d.mode).toBe("read-only")
    expect(d.reason).toContain("/etc/hosts")
    // read-only has wider modes; the denial must say so, or a model cannot recover.
    expect(d.escalation).toContain("workspace-write")
  })

  it("omits escalation guidance when no wider mode exists", () => {
    const d = denialFor("shell", "danger-full-access", "unreachable in practice")
    expect(d.escalation).toBeUndefined()
  })
})
