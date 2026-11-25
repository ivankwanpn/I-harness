import { createHash } from "node:crypto"
import type { Captured } from "../contracts/snapshot.ts"
import type { ConversationProjection } from "@i-harness/core-session"
import { captureData, isCapturedData } from "./data.ts"
import { canonicalJsonData } from "@i-harness/core-session"

function hashContextRevision(domain: string, value: unknown): string {
  return createHash("sha256").update(`i-harness:context:v1:${domain}\0`).update(canonicalJsonData(value)).digest("hex")
}

/** Versioned, domain-separated digests, never archive-length certificates. */
export function contextRevision(domain: string, value: unknown): string {
  return hashContextRevision(domain, captureData(value))
}

/** Input/source/acceptance identity excludes lifecycle and effect observations. */
export function semanticContextRevision(owner: string, conversation: Captured<ConversationProjection>): string {
  const items = conversation.items.filter(item => item.messages.length > 0 || item.exchange?.acceptance === "explicit").map(item => ({
    id: item.id, kind: item.kind, messages: item.messages, provenance: item.provenance, ...(item.replacement ? { replacement: item.replacement } : {}),
    sources: item.sources.filter(source => source.part !== "dispatch"),
    ...(item.exchange ? { exchange: { id: item.exchange.id, step: item.exchange.step, acceptance: item.exchange.acceptance,
      calls: item.exchange.calls.map(call => ({ callId: call.callId, name: call.name, call: call.call, result: call.result })) } } : {}),
  }))
  const semantic = [owner, items, ...(conversation.current ? [conversation.current] : [])]
  // The wrappers are local, and the snapshot already owns their nested data.
  // Canonical encoding omits the same undefined optional fields as capture.
  return typeof owner === "string" && isCapturedData(conversation)
    ? hashContextRevision("semantic", semantic)
    : contextRevision("semantic", semantic)
}
