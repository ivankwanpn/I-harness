import type { Session, SessionEvent } from "./types.ts"
import { subscribers } from "./state.ts"

export function subscribe(session: Session, listener: (ev: SessionEvent) => void): () => void {
  let set = subscribers.get(session)
  if (!set) { set = new Set(); subscribers.set(session, set) }
  set.add(listener)
  return () => { subscribers.get(session)?.delete(listener) }
}

/** Notify live consumers without invoking the durable append/persistence hook.
 * A caller-supplied seq is stripped so a chunk can never move a replay cursor. */
export function publishTransient(session: Session, event: Extract<SessionEvent, { type: "assistant/chunk" | "reasoning/chunk" | "model/activity" }>): void {
  const { seq: _seq, ...live } = event
  subscribers.get(session)?.forEach((listener) => listener(live))
}
