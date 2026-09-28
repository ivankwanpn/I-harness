import { randomUUID } from "node:crypto"
import { registerApprovalAnswerer, registerQuestionProvider, type ApprovalRequest, type UserQuestion } from "@i-harness/interaction"
import { makeNotification } from "@i-harness/sdk"
import type { SessionAssembly } from "@i-harness/session-executor"
import type { RpcNotification } from "@i-harness/sdk"
import type { SettingsApprovalMode } from "@i-harness/settings"

export type InteractionDecision =
  | { kind: "approval"; approved: boolean }
  | { kind: "question"; answer: string }

export interface PendingInteraction {
  requestId: string
  sessionId: string
  kind: InteractionDecision["kind"]
  payload: unknown
  openedAt: number
}

export interface InteractionBridge {
  attach(assembly: SessionAssembly): void
  pending(sessionId?: string): PendingInteraction[]
  reply(input: { requestId: string; sessionId: string; decision: InteractionDecision }): { accepted: true }
  cancelSession(sessionId: string): void
  close(): void
}

interface WaitingRequest {
  view: PendingInteraction
  timer: ReturnType<typeof setTimeout>
  settle: (decision: InteractionDecision | undefined, reason: "reply" | "expired" | "closed" | "cancelled") => void
}

const REQUEST_LIFETIME_MS = 24 * 60 * 60 * 1000

export function createInteractionBridge(emit: (frame: RpcNotification) => void, options: { approvalMode?: () => SettingsApprovalMode } = {}): InteractionBridge {
  const waiting = new Map<string, WaitingRequest>()
  let closed = false

  function finish(row: WaitingRequest, decision: InteractionDecision | undefined, reason: "reply" | "expired" | "closed" | "cancelled"): void {
    if (waiting.get(row.view.requestId) !== row) return
    waiting.delete(row.view.requestId)
    clearTimeout(row.timer)
    row.settle(decision, reason)
    try {
      emit(makeNotification("desktop/interaction/closed", {
        requestId: row.view.requestId,
        sessionId: row.view.sessionId,
        reason,
      }))
    } catch {
      // The decision has already settled. A broken client cannot reopen it.
    }
  }

  function enqueue(
    sessionId: string,
    kind: PendingInteraction["kind"],
    payload: ApprovalRequest | UserQuestion,
    settle: WaitingRequest["settle"],
  ): void {
    if (closed) {
      settle(undefined, "closed")
      return
    }
    const view: PendingInteraction = {
      requestId: randomUUID(), sessionId, kind, payload: { ...payload }, openedAt: Date.now(),
    }
    const row: WaitingRequest = {
      view,
      timer: setTimeout(() => finish(row, undefined, "expired"), REQUEST_LIFETIME_MS),
      settle,
    }
    waiting.set(view.requestId, row)
    try {
      emit(makeNotification("desktop/interaction/request", view))
    } catch {
      finish(row, undefined, "closed")
    }
  }

  function waitForApproval(sessionId: string, request: ApprovalRequest): Promise<{ approved: boolean }> {
    // Full access is an explicit saved user setting; it applies to the approval
    // answerer as well as the tool guard, including per-call escalation asks.
    if (options.approvalMode?.() === "full-access") return Promise.resolve({ approved: true })
    return new Promise((resolve) => enqueue(sessionId, "approval", request, (decision) => {
      resolve({ approved: decision?.kind === "approval" && decision.approved === true })
    }))
  }

  function waitForAnswer(sessionId: string, question: UserQuestion): Promise<string> {
    return new Promise((resolve, reject) => enqueue(sessionId, "question", question, (decision, reason) => {
      if (decision?.kind === "question") resolve(decision.answer)
      else reject(new Error(`question ${reason} (NO_PROVIDER)`))
    }))
  }

  return {
    attach(assembly) {
      if (closed || assembly.sessionId === undefined) return
      const sessionId = assembly.sessionId
      registerApprovalAnswerer(assembly.ctx, (request) => waitForApproval(sessionId, request))
      registerQuestionProvider(assembly.ctx, { ask: (question) => waitForAnswer(sessionId, question) })
    },
    pending(sessionId) {
      return [...waiting.values()]
        .filter((row) => sessionId === undefined || row.view.sessionId === sessionId)
        .map((row) => ({ ...row.view, payload: { ...(row.view.payload as object) } }))
    },
    reply(input) {
      if (closed) throw new Error("interaction bridge closed")
      const row = waiting.get(input.requestId)
      if (row === undefined) throw new Error("unknown or settled interaction request")
      if (row.view.sessionId !== input.sessionId) throw new Error("interaction session mismatch")
      if (row.view.kind !== input.decision.kind) throw new Error("interaction decision kind mismatch")
      if (input.decision.kind === "approval" && typeof input.decision.approved !== "boolean") {
        throw new Error("approval decision must be boolean")
      }
      if (input.decision.kind === "question" && typeof input.decision.answer !== "string") {
        throw new Error("question answer must be text")
      }
      finish(row, input.decision, "reply")
      return { accepted: true }
    },
    cancelSession(sessionId) {
      for (const row of [...waiting.values()]) {
        if (row.view.sessionId === sessionId) finish(row, undefined, "cancelled")
      }
    },
    close() {
      if (closed) return
      closed = true
      for (const row of [...waiting.values()]) finish(row, undefined, "closed")
    },
  }
}
