import { append } from "./index.ts"
import type { Session } from "./index.ts"

export type InputDelivery = "queue" | "steer"
export type InputIntent = "user" | "system"
export interface InputSynthetic { description: string; scope: "turn" | "session" }

export interface AdmittedInput {
  inputId: string
  text: string
  delivery: InputDelivery
  intent: InputIntent
  synthetic?: InputSynthetic
}

export interface PendingInput extends AdmittedInput { admittedSeq: number }

/** Source marker on promoted system-intent user/messages. */
export const SYSTEM_INPUT_PLUGIN = "i-harness/system-input"

// R-A1 durable input mailbox: a replay-once projection over
// `agent/input/admitted|promoted|cancelled` (dsh Inbox / opencode
// admit→promote→cancel ladder, re-implemented). All mutation goes through
// session-log appends, so persistence is the log's own (coordinator mirror
// onAppend hook) and a cold resume rebuilds pending from the log alone.
export class Inbox {
  private readonly fromSeq: number

  constructor(private readonly session: Session, fromSeq = 0) {
    this.fromSeq = fromSeq
  }

  /**
   * Durably enqueue an input. Throws on a duplicate currently-pending id or a
   * malformed admission (fail-closed — a bad input can never sit silently in
   * the queue). Returns the admitted event's seq.
   */
  admit(input: AdmittedInput): number {
    validateAdmitted(input)
    if (this.isPending(input.inputId)) {
      throw new Error(`agent/input admitted: input already pending (duplicate id: ${input.inputId})`)
    }
    append(this.session, {
      type: "agent/input/admitted",
      version: 1,
      inputId: input.inputId,
      text: input.text,
      delivery: input.delivery,
      intent: input.intent,
      ...(input.synthetic !== undefined ? { synthetic: input.synthetic } : {}),
    })
    return this.session.events.at(-1)!.seq!
  }

  /** Mark an admitted input consumed (append-only marker; the turn's user/
   *  message follows in the log). Returns false when not pending. */
  promote(inputId: string): boolean {
    if (!this.isPending(inputId)) return false
    append(this.session, { type: "agent/input/promoted", version: 1, inputId })
    return true
  }

  /** Retract a never-promoted input. Returns false when not pending. */
  cancel(inputId: string, reason?: string): boolean {
    if (!this.isPending(inputId)) return false
    append(this.session, {
      type: "agent/input/cancelled", version: 1, inputId,
      ...(reason !== undefined ? { reason } : {}),
    })
    return true
  }

  /** Pending inputs in admission order (all deliveries, both intents). */
  pending(): PendingInput[] {
    const consumed = new Set<string>()
    for (const ev of this.session.events) {
      if (ev.type === "agent/input/promoted" || ev.type === "agent/input/cancelled") {
        consumed.add((ev as { inputId: string }).inputId)
      }
    }
    const result: PendingInput[] = []
    for (const ev of this.session.events) {
      if (ev.type !== "agent/input/admitted") continue
      if ((ev.seq ?? 0) < this.fromSeq) continue
      const a = ev as unknown as { inputId: string; text: string; delivery: InputDelivery; intent: InputIntent; synthetic?: InputSynthetic }
      if (consumed.has(a.inputId)) continue
      result.push({
        inputId: a.inputId, text: a.text, delivery: a.delivery, intent: a.intent,
        ...(a.synthetic !== undefined ? { synthetic: a.synthetic } : {}),
        admittedSeq: ev.seq ?? 0,
      })
    }
    return result
  }

  isPending(inputId: string): boolean {
    return this.pending().some((p) => p.inputId === inputId)
  }

  /**
   * Agent-loop step-boundary seam (provider boundary): promote every pending
   * STEER in admission order, appending its model-visible user/message. Called
   * at the start of each step so mid-turn steering reaches the model before
   * the next provider call.
   */
  claimAtStepBoundary(): void {
    for (const p of this.pending().filter((i) => i.delivery === "steer")) {
      append(this.session, { type: "agent/input/promoted", version: 1, inputId: p.inputId })
      append(this.session, {
        type: "user/message",
        text: p.text,
        ...(p.intent === "system"
          ? { source: { kind: "plugin" as const, plugin: SYSTEM_INPUT_PLUGIN } }
          : {}),
      })
    }
  }
}

function validateAdmitted(input: AdmittedInput): void {
  if (typeof input.inputId !== "string" || input.inputId.length === 0) throw new Error("agent/input admitted: inputId must be a non-empty string")
  if (typeof input.text !== "string" || input.text.length === 0) throw new Error("agent/input admitted: text must be a non-empty string")
  if (input.delivery !== "queue" && input.delivery !== "steer") throw new Error(`agent/input admitted: invalid delivery '${String(input.delivery)}'`)
  if (input.intent !== "user" && input.intent !== "system") throw new Error(`agent/input admitted: invalid intent '${String(input.intent)}'`)
  if (input.synthetic !== undefined) {
    if (typeof input.synthetic.description !== "string" || input.synthetic.description.length === 0) {
      throw new Error("agent/input admitted: synthetic.description must be a non-empty string")
    }
    if (input.synthetic.scope !== "turn" && input.synthetic.scope !== "session") {
      throw new Error(`agent/input admitted: invalid synthetic.scope '${String(input.synthetic.scope)}'`)
    }
  }
}
