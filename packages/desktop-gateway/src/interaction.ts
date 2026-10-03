import { randomUUID } from "node:crypto"
import { registerApprovalAnswerer, registerQuestionProvider, type ApprovalRequest, type UserQuestion } from "@i-harness/interaction"
import { makeNotification } from "@i-harness/sdk"
import type { SessionAssembly } from "@i-harness/session-executor"
import type { RpcNotification } from "@i-harness/sdk"
import type { SettingsApprovalMode } from "@i-harness/settings"
import type { ApprovalRulesAdapter, RememberApprovalOptions } from "./approval-rules.ts"

export type InteractionDecision =
  | { kind: "approval"; approved: boolean; remember?: RememberApprovalOptions }
  | { kind: "question"; answer: string }

export interface PendingInteraction {
  requestId: string
  sessionId: string
  kind: InteractionDecision["kind"]
  payload: unknown
  openedAt: number
  expiresAt?: number
  /** Only a fresh live request owns a resolver. Restored cards save new input. */
  state?: "interrupted"
}

export interface InteractionPersistence {
  read(): PendingInteraction[]
  write(rows: PendingInteraction[]): void
}

export interface InteractionRecoveryInput {
  request: PendingInteraction
  decision: InteractionDecision
  inputId: string
  text: string
  signal: AbortSignal
}

export interface InteractionBridgeOptions {
  approvalRules?: ApprovalRulesAdapter
  approvalMode?: () => SettingsApprovalMode
  persistence?: InteractionPersistence
  /** Resolve only after idempotently admitting this stable inputId durably.
   * This callback must not execute the old tool call or grant its permission. */
  recover?: (input: InteractionRecoveryInput) => Promise<void>
}

export interface InteractionBridge {
  attach(assembly: SessionAssembly): void
  pending(sessionId?: string): PendingInteraction[]
  reply(input: { requestId: string; sessionId: string; decision: InteractionDecision }): { accepted: true } | Promise<{ accepted: true }>
  /** Call exclusively from authenticated Desktop human UI ingress. */
  replyTrustedHuman(input: { requestId: string; sessionId: string; decision: InteractionDecision }): { accepted: true } | Promise<{ accepted: true }>
  /** Explicit settings action against a currently pending live request. */
  rememberPending(input: { requestId: string; sessionId: string; remember: RememberApprovalOptions }): { accepted: true }
  cancelSession(sessionId: string): void
  close(): void
}

interface WaitingRequest {
  view: PendingInteraction
  timer: ReturnType<typeof setTimeout>
  settle?: (decision: InteractionDecision | undefined, reason: "reply" | "expired" | "closed" | "cancelled") => void
  recovering?: AbortController
}

const REQUEST_LIFETIME_MS = 24 * 60 * 60 * 1000

export function createInteractionBridge(emit: (frame: RpcNotification) => void, options: InteractionBridgeOptions = {}): InteractionBridge {
  const waiting = new Map<string, WaitingRequest>()
  let closed = false

  function snapshot(): PendingInteraction[] {
    return [...waiting.values()].map((row) => structuredClone(row.view))
  }

  function finish(row: WaitingRequest, decision: InteractionDecision | undefined, reason: "reply" | "expired" | "closed" | "cancelled"): void {
    if (waiting.get(row.view.requestId) !== row) return
    // A successful reply/cancel is durable before its resolver or notification.
    // Closing preserves snapshots: their async resolvers cannot survive restart.
    if (reason !== "closed") options.persistence?.write(snapshot().filter((view) => view.requestId !== row.view.requestId))
    waiting.delete(row.view.requestId)
    if (row.view.kind === "approval") options.approvalRules?.forget(row.view.payload as ApprovalRequest)
    clearTimeout(row.timer)
    if (reason !== "reply") row.recovering?.abort(new Error(`interaction ${reason}`))
    row.settle?.(decision, reason)
    try {
      if (reason === "closed" && options.persistence) {
        // A saved card is still actionable as a new input. Keeping it visible
        // also avoids a renderer closed-id tombstone hiding it on reconnect.
        emit(makeNotification("desktop/interaction/request", { ...structuredClone(row.view), state: "interrupted" }))
      } else {
        emit(makeNotification("desktop/interaction/closed", {
          requestId: row.view.requestId,
          sessionId: row.view.sessionId,
          reason,
        }))
      }
    } catch {
      // The decision has already settled. A broken client cannot reopen it.
    }
  }

  function expiryTimer(row: WaitingRequest): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      try { finish(row, undefined, "expired") }
      catch (error) {
        // Disk failure cannot extend a live permission request. The stored
        // deadline also makes the leftover snapshot expire on next open.
        waiting.delete(row.view.requestId)
        row.recovering?.abort(new Error("interaction expired"))
        row.settle?.(undefined, "expired")
        console.warn("[desktop] interaction expiry could not be saved", error)
      }
    }, Math.max(0, (row.view.expiresAt ?? row.view.openedAt + REQUEST_LIFETIME_MS) - Date.now()))
    timer.unref?.()
    return timer
  }

  const saved = options.persistence?.read() ?? []
  for (const view of saved) {
    const expiresAt = view.expiresAt ?? view.openedAt + REQUEST_LIFETIME_MS
    if (expiresAt <= Date.now()) continue
    const row: WaitingRequest = {
      view: { ...structuredClone(view), expiresAt, state: "interrupted" },
      timer: undefined as unknown as ReturnType<typeof setTimeout>,
    }
    row.timer = expiryTimer(row)
    waiting.set(view.requestId, row)
  }
  if (saved.length !== waiting.size) options.persistence?.write(snapshot())

  function enqueue(
    sessionId: string,
    kind: PendingInteraction["kind"],
    payload: ApprovalRequest | UserQuestion,
    settle: NonNullable<WaitingRequest["settle"]>,
  ): void {
    if (closed) {
      settle(undefined, "closed")
      return
    }
    const openedAt = Date.now()
    const view: PendingInteraction = { requestId: randomUUID(), sessionId, kind, payload: structuredClone(payload), openedAt, expiresAt: openedAt + REQUEST_LIFETIME_MS }
    const row: WaitingRequest = {
      view,
      timer: undefined as unknown as ReturnType<typeof setTimeout>,
      settle,
    }
    // A failed write denies/rejects the request before anything is presented.
    try { options.persistence?.write([...snapshot(), structuredClone(view)]) }
    catch { settle(undefined, "closed"); return }
    row.timer = expiryTimer(row)
    waiting.set(view.requestId, row)
    try {
      emit(makeNotification("desktop/interaction/request", view))
    } catch {
      finish(row, undefined, "closed")
    }
  }

  function waitForApproval(sessionId: string, request: ApprovalRequest): Promise<{ approved: boolean }> {
    if (closed) return Promise.resolve({ approved: false })
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

  const bridge: InteractionBridge = {
    attach(assembly) {
      if (closed || assembly.sessionId === undefined) return
      const sessionId = assembly.sessionId
      options.approvalRules?.attach(assembly)
      registerApprovalAnswerer(assembly.ctx, (request) => waitForApproval(sessionId, request))
      registerQuestionProvider(assembly.ctx, { ask: (question) => waitForAnswer(sessionId, question) })
    },
    pending(sessionId) {
      return [...waiting.values()]
        .filter((row) => sessionId === undefined || row.view.sessionId === sessionId)
        .map((row) => structuredClone(row.view))
    },
    reply(input) {
      if (input.decision.kind === "approval" && input.decision.remember !== undefined) throw new Error("remembering requires trusted human UI input")
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
      if ((row.view.expiresAt ?? row.view.openedAt + REQUEST_LIFETIME_MS) <= Date.now()) {
        finish(row, undefined, "expired")
        throw new Error("interaction request expired")
      }
      if (row.view.state === "interrupted") {
        if (row.recovering) throw new Error("interaction recovery already in progress")
        if (input.decision.kind === "approval" && !input.decision.approved) {
          finish(row, undefined, "cancelled")
          return { accepted: true }
        }
        if (!options.recover) throw new Error("interrupted interaction recovery is unavailable")
        const controller = new AbortController()
        row.recovering = controller
        let recovery: Promise<void>
        try {
          recovery = options.recover({
            request: structuredClone(row.view), decision: { ...input.decision },
            inputId: `interaction-recovery-${row.view.requestId}`,
            text: recoveryText(row.view, input.decision), signal: controller.signal,
          })
        } catch (error) {
          delete row.recovering
          return Promise.reject(error)
        }
        return recovery.then(() => {
          controller.signal.throwIfAborted()
          finish(row, undefined, "reply")
          return { accepted: true as const }
        }).finally(() => { if (row.recovering === controller) delete row.recovering })
      }
      finish(row, input.decision, "reply")
      return { accepted: true }
    },
    replyTrustedHuman(input) {
      if (input.decision.kind !== "approval" || input.decision.remember === undefined) return bridge.reply(input)
      const row = waiting.get(input.requestId)
      if (closed || !row || row.view.sessionId !== input.sessionId || row.view.kind !== "approval" || !row.settle || row.view.state === "interrupted" || (row.view.expiresAt ?? 0) <= Date.now()) throw new Error("only a live owned human approval can create a rule")
      if (input.decision.approved !== true) throw new Error("denied requests cannot create approval rules")
      if (!options.approvalRules) throw new Error("approval rules are unavailable")
      const rule = options.approvalRules.grant(row.view.payload as ApprovalRequest, input.sessionId, input.decision.remember)
      try { return bridge.reply({ ...input, decision: { kind: "approval", approved: true } }) }
      catch (error) { options.approvalRules.revoke(rule.evidence.workspaceId, rule.id); throw error }
    },
    rememberPending(input) {
      const row = waiting.get(input.requestId)
      if (closed || !row || row.view.sessionId !== input.sessionId || row.view.kind !== "approval" || !row.settle || row.view.state === "interrupted" || (row.view.expiresAt ?? 0) <= Date.now()) throw new Error("only a live owned human approval can create a rule")
      if (!options.approvalRules) throw new Error("approval rules are unavailable")
      options.approvalRules.grant(row.view.payload as ApprovalRequest, input.sessionId, input.remember)
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
  return bridge
}

function recoveryText(request: PendingInteraction, decision: InteractionDecision): string {
  if (decision.kind === "question") {
    const payload = request.payload as { prompt?: unknown }
    const prompt = typeof payload?.prompt === "string" ? payload.prompt : "Interrupted question"
    return `The conversation stopped while waiting for my answer. Continue using this answer to the interrupted question.\nQuestion: ${prompt}\nMy answer: ${decision.answer}`
  }
  return `The conversation stopped while waiting for permission for the operation below. Reassess whether it is still needed using the current workspace and permission settings. This request does not grant permission or authorize replay of the old tool call. Request fresh approval if the current policy requires it.\nInterrupted operation: ${JSON.stringify(request.payload)}`
}
