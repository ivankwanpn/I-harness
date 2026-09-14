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

  it("an explicit null target withholds escalation guidance entirely", () => {
    // Discriminating on purpose: asserted from "workspace-write", where the
    // DEFAULT does attach guidance (danger-full-access is strictly wider). From
    // "danger-full-access" the same assertion would pass for the wrong reason --
    // that mode has no wider mode at all -- and would pin nothing.
    const byDefault = denialFor("fs", "workspace-write", "refusing to modify /etc/hosts")
    expect(byDefault.escalation).toBeDefined()

    const withheld = denialFor("fs", "workspace-write", "refusing to modify /etc/hosts", null)
    expect(withheld.escalation).toBeUndefined()
    expect(withheld.code).toBe("SANDBOX_DENIED")
    expect(withheld.surface).toBe("fs")
    expect(withheld.mode).toBe("workspace-write")
    expect(withheld.reason).toContain("/etc/hosts")
  })

  it("an explicit target that is not strictly wider yields no guidance at all", () => {
    // "Retry with sandbox_permissions X" is only advice if X would actually lift
    // THIS refusal. A target equal to, or narrower than, the mode in force would
    // be refused again by the same mode, so it is treated as no route at all --
    // never advertised (the terminal's first-wider-mode bug was the same class).
    for (const target of ["workspace-write", "read-only"] as const) {
      const d = denialFor("fs", "workspace-write", "refusing to modify /etc/hosts", target)
      expect(d.escalation, `"${target}" is not strictly wider than workspace-write`).toBeUndefined()
      expect(d.mode).toBe("workspace-write")
    }

    // The strictly-wider target still advertises, or the check above would be
    // satisfied by simply never emitting guidance.
    const wider = denialFor("fs", "workspace-write", "refusing to modify /etc/hosts", "danger-full-access")
    expect(wider.escalation).toContain('"danger-full-access"')
  })
})
