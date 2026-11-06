import { describe, expect, it } from "vitest"
import { isRecoveryFailure, isSessionScopedRequest, isTransientReadRetry } from "../src/main/session-recovery.ts"

describe("isRecoveryFailure", () => {
  it("recognises the recovery-gated sentences that cross the RPC boundary", () => {
    expect(isRecoveryFailure(new Error("Error invoking remote method 'ih-desktop/request': RpcError: Original writer dependency cleanup unresolved"))).toBe(true)
    expect(isRecoveryFailure(new Error("Managed facts require reconciliation"))).toBe(true)
    expect(isRecoveryFailure(Object.assign(new Error("original admission requires explicit recovery"), { code: "FACT_RECOVERY_REQUIRED" }))).toBe(true)
  })

  it("leaves unrelated failures alone", () => {
    expect(isRecoveryFailure(new Error("ENOENT: no such file or directory"))).toBe(false)
    expect(isRecoveryFailure("plain text")).toBe(false)
    expect(isRecoveryFailure(undefined)).toBe(false)
  })
})

describe("isSessionScopedRequest", () => {
  it("requires both a workspace and a session identity", () => {
    expect(isSessionScopedRequest({ kind: "desktop/session/work-state", workspaceId: "w", sessionId: "s" })).toBe(true)
    expect(isSessionScopedRequest({ workspaceId: "w" })).toBe(false)
    expect(isSessionScopedRequest({ workspaceId: "", sessionId: "s" })).toBe(false)
    expect(isSessionScopedRequest({ workspaceId: "w", sessionId: 3 })).toBe(false)
    expect(isSessionScopedRequest(null)).toBe(false)
  })
})
describe("isTransientReadRetry", () => {
  const failure = new Error("RpcError: Original writer dependency cleanup unresolved")
  it("retries session reads that can refuse while a turn prepares", () => {
    for (const kind of ["session/history", "session/context", "session/dashboard", "session/tasks", "desktop/session/work-state", "desktop/session/input/state", "desktop/session/project/state", "desktop/interaction/pending", "session/model/state", "desktop/session/navigation/state"]) {
      expect(isTransientReadRetry(failure, { kind, workspaceId: "w", sessionId: "s" })).toBe(true)
    }
  })
  it("never retries prompts, writes or non-recovery failures", () => {
    expect(isTransientReadRetry(failure, { kind: "session/prompt", workspaceId: "w", sessionId: "s" })).toBe(false)
    expect(isTransientReadRetry(failure, { kind: "desktop/session/reload", workspaceId: "w", sessionId: "s" })).toBe(false)
    expect(isTransientReadRetry(new Error("ENOENT"), { kind: "session/history", workspaceId: "w", sessionId: "s" })).toBe(false)
    expect(isTransientReadRetry(failure, { kind: "session/history", workspaceId: "w" })).toBe(false)
  })
})
