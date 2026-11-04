import { describe, expect, it } from "vitest"
import { isRecoveryFailure, isSessionScopedRequest } from "../src/main/session-recovery.ts"

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
