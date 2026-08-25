import { beforeEach, describe, expect, it } from "vitest"
import { tmpdir } from "node:os"
import {
  ESCALATION_TARGETS,
  WIDER_MODES,
  SandboxUnavailableError,
  approveEscalation,
  canonicalPath,
  escalationHintMarker,
  sandboxDenialMarker,
  validateEscalationArgs,
  writableRoots,
} from "../src/index.ts"
import type { EscalationOutcome } from "../src/index.ts"

describe("sandbox roots", () => {
  it("canonicalPath resolves symlinks and falls back to the as-spelled path", () => {
    const resolved = canonicalPath(process.cwd())
    expect(resolved.length).toBeGreaterThan(0)
    expect(canonicalPath("C:\\definitely-missing-path-xyz\\x")).toBe("C:\\definitely-missing-path-xyz\\x")
  })

  it("writableRoots: workspace-write is [workspaceRoot, '/tmp', tmpdir()] canonical + dedup", () => {
    const roots = writableRoots({ mode: "workspace-write", workspaceRoot: "/tmp" })
    // Every source root is canonicalized, so assert on the canonical forms of
    // the workspaceRoot ("/tmp"), the literal "/tmp", and tmpdir() (which may
    // coincide after realpath — e.g. /tmp is a junction at D:\tmp on Windows).
    const expected = [...new Set([canonicalPath("/tmp"), canonicalPath(tmpdir())])]
    expect([...roots].sort()).toEqual([...expected].sort())
    expect(new Set(roots).size).toBe(roots.length) // deduped
    expect(roots.length).toBeGreaterThan(0)
  })

  it("writableRoots: read-only is empty", () => {
    expect(writableRoots({ mode: "read-only", workspaceRoot: "/" })).toEqual([])
  })
})

describe("sandbox escalation vocabulary", () => {
  it("WIDER_MODES is the strictly-wider ladder", () => {
    expect(WIDER_MODES["read-only"]).toEqual(["workspace-write", "danger-full-access"])
    expect(WIDER_MODES["workspace-write"]).toEqual(["danger-full-access"])
  })

  it("ESCALATION_TARGETS is the closed target vocabulary", () => {
    expect(ESCALATION_TARGETS).toEqual(["workspace-write", "danger-full-access"])
  })

  it("validateEscalationArgs: pairing + non-empty justification", () => {
    expect(() => validateEscalationArgs("workspace-write", undefined)).toThrow(/sandbox_permissions/)
    expect(() => validateEscalationArgs(undefined, "why")).toThrow(/justification/)
    expect(() => validateEscalationArgs("workspace-write", "  ")).toThrow(/sentence/)
    expect(() => validateEscalationArgs(undefined, undefined)).not.toThrow()
    expect(() => validateEscalationArgs("workspace-write", "to write to workspace")).not.toThrow()
  })

  it("sandboxDenialMarker / escalationHintMarker exact strings", () => {
    expect(sandboxDenialMarker("read-only")).toBe("[sandbox: file access denied under read-only mode]")
    expect(escalationHintMarker("command")).toContain("[sandbox: escalation available")
    expect(escalationHintMarker("command")).toContain("sandbox_permissions")
  })
})

describe("approveEscalation", () => {
  const calls: Array<{ agent: string; toolName: string; callId: string; reason: string }> = []

  beforeEach(() => {
    calls.length = 0
  })

  function approver(outcome: EscalationOutcome) {
    return {
      approver: {
        async request(req: { agent: string; toolName: string; callId: string; reason: string; signal?: AbortSignal }): Promise<EscalationOutcome> {
          calls.push({ agent: req.agent, toolName: req.toolName, callId: req.callId, reason: req.reason })
          return outcome
        },
      },
      agent: "a1",
      callId: "c1",
      toolName: "bash",
    }
  }

  it("allowed-once returns the granted mode", async () => {
    const granted = await approveEscalation(
      { requestedMode: "workspace-write", justification: "need write", effectiveMode: "read-only", subject: "command" },
      approver("allowed-once"),
    )
    expect(granted).toBe("workspace-write")
    expect(calls[0]!.reason).toContain("escalate sandbox to workspace-write")
  })

  it("non-widening request throws without prompting", async () => {
    await expect(
      approveEscalation(
        { requestedMode: "read-only", justification: "x", effectiveMode: "read-only", subject: "command" },
        approver("allowed-once"),
      ),
    ).rejects.toThrow(/not strictly wider/)
    expect(calls).toHaveLength(0)
  })

  it("missing approver throws", async () => {
    await expect(
      approveEscalation(
        { requestedMode: "workspace-write", justification: "x", effectiveMode: "read-only", subject: "command" },
        { approver: undefined, agent: "a", callId: "c", toolName: "bash" },
      ),
    ).rejects.toThrow(/no approval service/)
  })

  it("rejected / cancelled / unavailable throw distinct messages", async () => {
    for (const out of ["rejected", "cancelled", "unavailable"] as const) {
      await expect(
        approveEscalation(
          { requestedMode: "workspace-write", justification: "x", effectiveMode: "read-only", subject: "command" },
          approver(out),
        ),
      ).rejects.toThrow(/escalat/)
    }
  })
})

describe("SandboxUnavailableError", () => {
  it("carries SANDBOX_UNAVAILABLE", () => {
    const err = new SandboxUnavailableError("read-only", "bwrap missing")
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toContain("read-only")
    expect(err.message).toContain("bwrap missing")
  })
})
