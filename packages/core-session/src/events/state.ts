import type { Session, SessionEvent } from "./types.ts"
import type { ConversationValidationIndex } from "../conversation/validation.ts"

export const conversationIndexes = new WeakMap<Session, { events: SessionEvent[]; index: ConversationValidationIndex }>()

// Optional per-session append observer (M4 persistence mirror). Stored in a
// WeakMap so the Session shape itself is unchanged.
export const appendHooks = new WeakMap<Session, (ev: SessionEvent) => void>()

// M23 G1 streaming base: multi-listener session subscription. Durable events
// carry the SAME object as the log (with seq); transient chunks have no seq.
// Clone semantics are decided by the subscriber (matches onAppend semantics —
// write-behind clones separately). Subscriptions take effect for events
// AFTER subscribe (no replay of past events); unsubscribe stops delivery.
export const subscribers = new WeakMap<Session, Set<(ev: SessionEvent) => void>>()
