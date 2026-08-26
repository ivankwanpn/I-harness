import { randomUUID } from "node:crypto"
import { TeamError, TEAM_CODES, type TeamCaller, type TeamMessageSnapshot } from "./types.ts"
import type { TeamFoldState } from "./fold.ts"
import type { TeamTransaction } from "./transact.ts"

export interface MailboxDeps {
  teamId: string
  // shared live folded state (created via createFoldState / foldTeam): the
  // mailbox's readers (pendingCount, target resolution, recovery sweep) and the
  // transact observe the same object.
  state: TeamFoldState
  transact: TeamTransaction
  // actual channel delivery (injected): returns true only after the target
  // durably holds the message (at-least-once). Signified by the returned
  // boolean — false keeps the message queued for recovery.
  deliver: (targetId: string, messageId: string, content: string, delivery: "quiet" | "wakeup", signal?: AbortSignal) => Promise<boolean>
  // live target status (by targetId); "inactive" targets never receive quiet
  // messages (quiet never wakes inactive), wakeup is always attempted.
  memberStatus: (id: string) => "running" | "idle" | "inactive" | "provisioning" | "failed"
  maxPendingMessagesPerMember?: number
  maxMessageBytes?: number // incl. framing
}

// Ruling 10(c): every fn passed to deps.transact is PURE-READ — it inspects the
// state param (guards are actually pre-checks against the live state) and
// returns { events, result }; it NEVER mutates the state. The transact runs the
// fn against a clone, validates candidates via applyTeamEvent, then applies
// them to the live state and appends to the log — so queue insertion and the
// delivered ack are applied once, in order, by the fold's own validation.
export function createMailbox(deps: MailboxDeps) {
  const maxPending = deps.maxPendingMessagesPerMember ?? 64
  const maxBytes = deps.maxMessageBytes ?? 65_536

  // Admitted = queued but not yet delivered (delivered entries stay in the
  // queue for idempotent replay and are not counted).
  function pendingCount(targetId: string): number {
    return (deps.state.queued.get(targetId) ?? []).filter((m) => !deps.state.delivered.has(m.id)).length
  }

  async function sendMessage(caller: TeamCaller, target: string, message: string, delivery: "quiet" | "wakeup", signal?: AbortSignal): Promise<{ messageId: string; status: "accepted" | "queued" }> {
    // Pre-checks read the LIVE state getters (read-only, no transact needed).
    if (caller.role === "teammate" && !deps.state.members.has(caller.name)) throw new TeamError(TEAM_CODES.NOT_MEMBER, `not a team member: ${caller.name}`)
    const targetId = target === "lead" ? deps.teamId : deps.state.members.get(target)?.id
    if (!targetId) throw new TeamError(TEAM_CODES.MEMBER_NOT_FOUND, `unknown target "${target}"`)
    if (caller.id === targetId) throw new TeamError(TEAM_CODES.SELF_MESSAGE, "cannot message yourself")
    const snapshot: TeamMessageSnapshot = { id: `msg-${randomUUID()}`, senderId: caller.id, senderName: caller.name, targetId, delivery, content: message }
    // Spec byte-limit framing: `Team message <id> from <name>:` + content.
    const framing = `Team message <${snapshot.id}> from <${caller.name}>:\n${message}`
    if (Buffer.byteLength(framing, "utf-8") > maxBytes) throw new TeamError(TEAM_CODES.MESSAGE_TOO_LARGE, `message exceeds ${maxBytes} bytes`)
    if (pendingCount(targetId) >= maxPending) throw new TeamError(TEAM_CODES.MAILBOX_FULL, `target queue full (${maxPending} pending)`)

    // Queue insert: pure-read fn — the transact runs it against a clone and
    // the authoritative MAILBOX_FULL re-check happens HERE, on the fn's state
    // param (the serialized chain means a concurrent send committed before us
    // is visible in the clone). The pre-check above is only a hot-path fast
    // fail; this in-fn check makes the limit atomic. The actual push is done
    // by the transact's applyTeamEvent against the live state (duplicate-id
    // guarded there).
    await deps.transact.transact((state) => {
      const pending = (state.queued.get(targetId) ?? []).filter((m) => !state.delivered.has(m.id)).length
      if (pending >= maxPending) throw new TeamError(TEAM_CODES.MAILBOX_FULL, `target queue full (${maxPending} pending)`)
      return { events: [{ type: "team/message/queued", version: 1, teamId: deps.teamId, message: snapshot }], result: undefined }
    })
    // Deliver on the actual channel; the ack is appended ONLY after the target
    // holds the message (deliver resolved true) — a false keeps it queued and
    // recoverRoot retries it.
    const delivered = await deps.deliver(targetId, snapshot.id, message, delivery, signal)
    if (delivered) {
      // Ack: pure-read fn; validated/duplicate-guarded by the transact.
      await deps.transact.transact(() => ({
        events: [{ type: "team/message/delivered", version: 1, teamId: deps.teamId, messageId: snapshot.id, targetId }],
        result: undefined,
      }))
      return { messageId: snapshot.id, status: "accepted" }
    }
    return { messageId: snapshot.id, status: "queued" }
  }

  // Recovery sweep (spec root-mount): iterate the live queued map in FIFO
  // order (Map keys in insertion order, arrays as queued), skip already
  // delivered, skip quiet-on-inactive (quiet never wakes inactive), attempt
  // delivery to the rest; on success ack via a pure-read transact fn. A crash
  // between deliver success and the ack replays the entry (at-least-once).
  async function recoverRoot(): Promise<void> {
    for (const [targetId, msgs] of [...deps.state.queued.entries()]) {
      // Snapshot the array: a concurrent sendMessage pushes into the live
      // array mid-sweep (while we await deliver), and iterating it live would
      // double-process the new entry in this pass.
      for (const m of [...msgs]) {
        if (deps.state.delivered.has(m.id)) continue
        if (m.delivery === "quiet" && deps.memberStatus(targetId) === "inactive") continue // quiet never wakes inactive
        const ok = await deps.deliver(targetId, m.id, m.content, m.delivery)
        if (ok) {
          await deps.transact.transact(() => ({
            events: [{ type: "team/message/delivered", version: 1, teamId: deps.teamId, messageId: m.id, targetId }],
            result: undefined,
          }))
        }
      }
    }
  }

  return { sendMessage, recoverRoot }
}
