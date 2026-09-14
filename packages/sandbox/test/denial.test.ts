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

  it("omitting the target is exactly the first strictly-wider mode (fs/shell unchanged)", () => {
    // The default must not drift: fs and shell refuse on a THRESHOLD (a wider
    // mode is precisely what the operation needs), so for them the first
    // strictly-wider mode is the right target and their advice is unchanged.
    const byDefault = denialFor("fs", "read-only", "refusing to modify /etc/hosts")
    const explicit = denialFor("fs", "read-only", "refusing to modify /etc/hosts", "workspace-write")
    expect(byDefault.escalation).toBe(explicit.escalation)
  })

  it("a caller may name the narrowest mode in which THIS operation is permitted", () => {
    // Not the same question as "a mode wider than this one". The terminal
    // refuses in EVERY confined mode (a PTY cannot be kernel-confined), so
    // advising the first strictly-wider mode from read-only -- "workspace-write"
    // -- sends the model to a retry that returns the identical denial. The
    // sufficient mode is danger-full-access.
    const d = denialFor("terminal", "read-only", "refusing to start a PTY", "danger-full-access")
    expect(d.escalation).toContain('"danger-full-access"')
    expect(d.escalation).not.toContain('"workspace-write"')
    expect(d.mode).toBe("read-only")
  })
})
