import { createHash } from "node:crypto"
import type { ImmutableJson } from "../contracts/snapshot.ts"
import type { Captured } from "../contracts/snapshot.ts"
import type { ConversationProjection } from "@i-harness/core-session"
import { captureData } from "./data.ts"
import { canonicalJsonData } from "@i-harness/core-session"

/** Versioned, domain-separated digests, never archive-length certificates. */
export function contextRevision(domain: string, value: unknown): string {
  return createHash("sha256").update(`i-harness:context:v1:${domain}\0`).update(canonicalJsonData(captureData(value) as ImmutableJson)).digest("hex")
}

/** Input/source/acceptance identity excludes lifecycle and effect observations. */
export function semanticContextRevision(owner: string, conversation: Captured<ConversationProjection>): string {
  const items = conversation.items.filter(item => item.messages.length > 0 || item.exchange?.acceptance === "explicit").map(item => ({
    id: item.id, kind: item.kind, messages: item.messages, provenance: item.provenance, ...(item.replacement ? { replacement: item.replacement } : {}),
    sources: item.sources.filter(source => source.part !== "dispatch"),
    ...(item.exchange ? { exchange: { id: item.exchange.id, step: item.exchange.step, acceptance: item.exchange.acceptance,
      calls: item.exchange.calls.map(call => ({ callId: call.callId, name: call.name, call: call.call, result: call.result })) } } : {}),
  }))
  return contextRevision("semantic", [owner, items])
}
