import { describe, expect, it } from "vitest"
import { createApprovalEscalationApprover, resolveCallPolicy } from "../src/index.ts"
import type {
  ApprovalPrompt,
  CallPolicyResolution,
  EscalationApprover,
  EscalationContext,
  EscalationOutcome,
  SandboxDenial,
  SandboxExecutionPolicy,
} from "../src/index.ts"

// The ladder's REQUEST side (spec §3.3): the seven branches of `resolveCallPolicy`
// in the order the task brief fixes, plus the one adapter that turns the host's
// boolean approval answerer into an `EscalationOutcome`.
//
// One property runs through every test here: NOTHING ESCAPES. Both functions this
// module calls -- `validateEscalationArgs` and `approveEscalation` -- THROW on every
// non-grant path, and a throwing tool body fails the whole turn and appends no
// `tool/result` (packages/fs/src/error.ts:19-31 states the same rule for fs). So
// every refusal below is asserted as a RESOLVED value, never as a rejection, and
// every denial from this module carries NO escalation guidance: this function only
// ever refuses the REQUEST, while `denialFor`'s guidance answers a refusal of the
// OPERATION (spec §3.2 corollary 2).

const SUBJECT = "write to C:\\outside\\file.txt"
const OUTSIDE_WRITE = {
  sandbox_permissions: "workspace-write",
  justification: "the file is generated outside the workspace",
}

/** Fresh each time: a test asserting "the standing policy did not move" needs its own. */
function readOnly(): SandboxExecutionPolicy {
  return { mode: "read-only", workspaceRoot: "C:\\ws", sessionId: "s1" }
}

function refused(resolution: CallPolicyResolution): SandboxDenial {
  if (resolution.kind !== "refused") {
    throw new Error(`expected a refusal, got a proceed: ${JSON.stringify(resolution)}`)
  }
  return resolution.denial
}

function proceeded(resolution: CallPolicyResolution): SandboxExecutionPolicy | undefined {
  if (resolution.kind !== "proceed") {
    throw new Error(`expected to proceed, got a refusal: ${JSON.stringify(resolution.denial)}`)
  }
  return resolution.policy
}

interface SeenPrompt {
  agent: unknown
  toolName: string
  callId: string
  reason: string
  signal?: AbortSignal
}

function recordingApprover(outcome: EscalationOutcome | (() => Promise<EscalationOutcome>)) {
  const prompts: SeenPrompt[] = []
  const approver: EscalationApprover<unknown, string> = {
    async request(req) {
      prompts.push(req)
      return typeof outcome === "function" ? await outcome() : outcome
    },
  }
  return { approver, prompts }
}

function context(overrides: Partial<EscalationContext> = {}): EscalationContext {
  return {
    approver: recordingApprover("allowed-once").approver,
    agent: { id: "agent-1" },
    callId: "call-7",
    toolName: "write",
    ...overrides,
  }
}

describe("resolveCallPolicy", () => {
  it("branch 1 (malformed pair): refuses with the validation message and NO escalation guidance", async () => {
    const malformed = [
      { args: { sandbox_permissions: "workspace-write" }, expected: /justification/ },
      { args: { justification: "because I said so" }, expected: /sandbox_permissions/ },
      { args: { sandbox_permissions: "workspace-write", justification: "   " }, expected: /sentence/ },
    ]
    for (const { args, expected } of malformed) {
      const denial = refused(
        await resolveCallPolicy({ base: readOnly(), surface: "fs", subject: SUBJECT, args, escalation: context() }),
      )
      expect(denial.code).toBe("SANDBOX_DENIED")
      expect(denial.surface).toBe("fs")
      expect(denial.mode).toBe("read-only")
      expect(denial.reason).toMatch(expected)
      // §3.2 corollary 2: the REQUEST was wrong, so "retry with sandbox_permissions"
      // would be advice to repeat the same mistake.
      expect(denial.escalation).toBeUndefined()
    }

    // No policy at all: the mode reported is the accurate one for "the host
    // requested no sandbox" -- unconfined. (Nothing here is refused at execution.)
    const unconfined = refused(
      await resolveCallPolicy({
        base: undefined,
        surface: "shell",
        subject: SUBJECT,
        args: { sandbox_permissions: "workspace-write" },
      }),
    )
    expect(unconfined.mode).toBe("danger-full-access")
    expect(unconfined.escalation).toBeUndefined()
  })

  it("branch 2 (no escalation arguments): proceeds with the base policy and asks nobody", async () => {
    for (const args of [{}, { sandbox_permissions: undefined, justification: undefined }]) {
      const { approver, prompts } = recordingApprover("allowed-once")
      const base = readOnly()
      const policy = proceeded(
        await resolveCallPolicy({ base, surface: "fs", subject: SUBJECT, args, escalation: context({ approver }) }),
      )
      expect(policy).toEqual(base)
      expect(prompts).toHaveLength(0)
    }
  })

  it("branch 3 (base === undefined): proceeds with undefined, ignoring the args", async () => {
    // Spec §3.3 point 5: there is no policy to escalate FROM, and approveEscalation
    // requires a non-optional effectiveMode, so the request cannot be constructed.
    // The call is already unrestricted.
    const { approver, prompts } = recordingApprover("allowed-once")
    const policy = proceeded(
      await resolveCallPolicy({
        base: undefined,
        surface: "fs",
        subject: SUBJECT,
        args: OUTSIDE_WRITE,
        escalation: context({ approver }),
      }),
    )
    expect(policy).toBeUndefined()
    expect(prompts).toHaveLength(0)
  })

  it("branch 4 (base.mode is danger-full-access): proceeds with the base policy, ignoring the args", async () => {
    // Not "wrong", vacuous: there is nothing to widen, and the only thing
    // approveEscalation could do with the request is throw "not strictly wider" --
    // which would start REFUSING a call that succeeds today on an unconfined host.
    const unconfined: SandboxExecutionPolicy = { mode: "danger-full-access", workspaceRoot: "C:\\ws" }
    const { approver, prompts } = recordingApprover("allowed-once")
    const policy = proceeded(
      await resolveCallPolicy({
        base: unconfined,
        surface: "shell",
        subject: SUBJECT,
        args: OUTSIDE_WRITE,
        escalation: context({ approver }),
      }),
    )
    expect(policy).toEqual(unconfined)
    expect(prompts).toHaveLength(0)
  })

  it("branch 5 (no approval channel): refuses -- fail closed, never a grant", async () => {
    // The requested mode is STRICTLY WIDER than base.mode on purpose:
    // approveEscalation tests strictly-wider (escalation.ts:61) BEFORE
    // approver-missing (:64), so a non-wider request would throw for the other
    // reason and this test would pass without branch 5 ever being exercised.
    const withoutContext = await resolveCallPolicy({
      base: readOnly(),
      surface: "fs",
      subject: SUBJECT,
      args: OUTSIDE_WRITE,
    })
    const withoutApprover = await resolveCallPolicy({
      base: readOnly(),
      surface: "fs",
      subject: SUBJECT,
      args: OUTSIDE_WRITE,
      escalation: context({ approver: undefined }),
    })

    // The discriminating assertions: a ladder branch 5 that fell through to
    // `proceed` on a missing approver would grant without ever asking.
    expect(withoutContext.kind).toBe("refused")
    expect(withoutApprover.kind).toBe("refused")

    const denial = refused(withoutContext)
    expect(denial.mode).toBe("read-only")
    expect(denial.reason).toMatch(/no approval service is composed/)
    expect(denial.reason).toMatch(/workspace-write/)
    expect(denial.escalation).toBeUndefined()
    expect(refused(withoutApprover).reason).toMatch(/no approval service is composed/)
    expect(refused(withoutApprover).escalation).toBeUndefined()
  })

  it("branch 6 (not granted): every non-grant outcome refuses with no escalation guidance", async () => {
    for (const outcome of ["rejected", "cancelled", "unavailable"] as const) {
      const { approver, prompts } = recordingApprover(outcome)
      const denial = refused(
        await resolveCallPolicy({
          base: readOnly(),
          surface: "fs",
          subject: SUBJECT,
          args: OUTSIDE_WRITE,
          escalation: context({ approver }),
        }),
      )
      expect(prompts).toHaveLength(1) // the question WAS asked; the answer refused
      expect(denial.mode).toBe("read-only")
      expect(denial.reason).toMatch(/workspace-write/)
      expect(denial.escalation).toBeUndefined()
    }

    // A mode that is not strictly wider is refused BEFORE anyone is asked.
    const { approver, prompts } = recordingApprover("allowed-once")
    const narrower = refused(
      await resolveCallPolicy({
        base: readOnly(),
        surface: "fs",
        subject: SUBJECT,
        args: { sandbox_permissions: "read-only", justification: "please" },
        escalation: context({ approver }),
      }),
    )
    expect(prompts).toHaveLength(0)
    expect(narrower.reason).toMatch(/not strictly wider/)
    expect(narrower.escalation).toBeUndefined()
  })

  it("branch 6: an approval channel that THROWS is a refusal, never an escaping throw", async () => {
    const { approver } = recordingApprover(async () => {
      throw new Error("the answerer crashed mid-prompt")
    })
    const denial = refused(
      await resolveCallPolicy({
        base: readOnly(),
        surface: "fs",
        subject: SUBJECT,
        args: OUTSIDE_WRITE,
        escalation: context({ approver }),
      }),
    )
    expect(denial.reason).toMatch(/crashed mid-prompt/)
    expect(denial.escalation).toBeUndefined()
  })

  it("branch 6: an escalation with no agent to route it through refuses rather than throwing", async () => {
    const { approver } = recordingApprover("allowed-once")
    const denial = refused(
      await resolveCallPolicy({
        base: readOnly(),
        surface: "fs",
        subject: SUBJECT,
        args: OUTSIDE_WRITE,
        escalation: context({ approver, agent: undefined }),
      }),
    )
    expect(denial.reason).toMatch(/no agent/)
    expect(denial.escalation).toBeUndefined()
  })

  it("branch 7 (granted): proceeds under the granted mode, with the rest of the policy intact", async () => {
    const { approver, prompts } = recordingApprover("allowed-once")
    const base = readOnly()
    const policy = proceeded(
      await resolveCallPolicy({ base, surface: "fs", subject: SUBJECT, args: OUTSIDE_WRITE, escalation: context({ approver }) }),
    )
    expect(policy).toEqual({ ...base, mode: "workspace-write" })
    // The grant covers THIS call: the base policy object is not mutated, so the
    // standing mode never moves and no sandbox/mode event may be appended
    // (spec §3.3 point 1 -- escalation is per-call and transient).
    expect(base.mode).toBe("read-only")

    expect(prompts).toHaveLength(1)
    expect(prompts[0]!.callId).toBe("call-7")
    expect(prompts[0]!.toolName).toBe("write")
    expect(prompts[0]!.reason).toContain("escalate sandbox to workspace-write")
    expect(prompts[0]!.reason).toContain("the file is generated outside the workspace")
  })

  it("branch 7 end-to-end: only the host answerer's `true` widens the call", async () => {
    const granted = createApprovalEscalationApprover(() => async () => true)
    const widened = proceeded(
      await resolveCallPolicy({
        base: readOnly(),
        surface: "fs",
        subject: SUBJECT,
        args: OUTSIDE_WRITE,
        escalation: context({ approver: granted }),
      }),
    )
    expect(widened?.mode).toBe("workspace-write")

    const denied = createApprovalEscalationApprover(() => async () => false)
    const denial = refused(
      await resolveCallPolicy({
        base: readOnly(),
        surface: "fs",
        subject: SUBJECT,
        args: OUTSIDE_WRITE,
        escalation: context({ approver: denied }),
      }),
    )
    expect(denial.reason).toMatch(/rejected/)
    expect(denial.escalation).toBeUndefined()
  })
})

describe("createApprovalEscalationApprover", () => {
  const request = { agent: { id: "a" }, toolName: "bash", callId: "c1", reason: "escalate sandbox to workspace-write: because" }

  it("maps an approved answer to allowed-once, and asks with the tool name + escalation reason", async () => {
    const seen: Array<{ name: string; reason: string }> = []
    const approver = createApprovalEscalationApprover(() => async (req) => {
      seen.push(req)
      return true
    })
    await expect(approver.request(request)).resolves.toBe("allowed-once")
    expect(seen).toEqual([{ name: "bash", reason: request.reason }])
  })

  it("maps a denied answer to rejected", async () => {
    const approver = createApprovalEscalationApprover(() => async () => false)
    await expect(approver.request(request)).resolves.toBe("rejected")
  })

  it("maps an unregistered service (getter returns undefined) to unavailable -- never a silent allow", async () => {
    const approver = createApprovalEscalationApprover(() => undefined)
    await expect(approver.request(request)).resolves.toBe("unavailable")
  })

  it("maps a getter that THROWS (services.get on an unregistered name) to unavailable", async () => {
    const approver = createApprovalEscalationApprover(() => {
      throw new Error("service approval/answerer is not registered")
    })
    await expect(approver.request(request)).resolves.toBe("unavailable")
  })

  it("reads the getter per request, so an answerer registered after mounting still works", async () => {
    let registered: ApprovalPrompt | undefined
    const approver = createApprovalEscalationApprover(() => registered)
    await expect(approver.request(request)).resolves.toBe("unavailable")
    registered = async () => true
    await expect(approver.request(request)).resolves.toBe("allowed-once")
  })

  it("accepts a richer request shape (the interaction ApprovalRequest carries optional extras)", async () => {
    // Structural, not nominal: `ApprovalPrompt` names only the two fields it reads,
    // so the real seam's answerer -- `(req: ApprovalRequest) => Promise<boolean>`,
    // whose request also carries command/argv/dangerClass/pathSummary -- is
    // assignable without this package importing @i-harness/interaction.
    const richer: ApprovalPrompt = async (req: {
      name: string
      reason: string
      command?: string
      argv?: string[]
      dangerClass?: "extreme" | "dangerous" | "none"
      pathSummary?: string
    }) => req.name === "bash"
    const approver = createApprovalEscalationApprover(() => richer)
    await expect(approver.request(request)).resolves.toBe("allowed-once")
  })

  it("does not treat a non-boolean answer as a grant", async () => {
    // interaction normalizes `{ approved }` to a boolean at the service boundary; a
    // host that bypassed it must still not fail open here.
    const sloppy = (async () => ({ approved: true })) as unknown as ApprovalPrompt
    const approver = createApprovalEscalationApprover(() => sloppy)
    await expect(approver.request(request)).resolves.toBe("rejected")
  })
})
