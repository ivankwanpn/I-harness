import { createHash } from "node:crypto"
import type { Captured } from "../contracts/snapshot.ts"
import { canonicalJsonData, streamJsonData, type ConversationProjection } from "@i-harness/core-session"
import { captureData, isCapturedData } from "./data.ts"

const originalStringify = JSON.stringify
const originalJoin = Array.prototype.join
const semanticBatchUnits = 16 * 1024

function revisionHash(domain: string) {
  return createHash("sha256").update(`i-harness:context:v1:${domain}\0`)
}

function hashContextRevision(domain: string, value: unknown): string {
  return revisionHash(domain).update(canonicalJsonData(value)).digest("hex")
}

/** The semantic tuple always emits a nonempty JSON array. Native tokenizer
 * fragments never split a surrogate pair, so each batch is a UTF-8 boundary. */
function hashOwnedSemanticTuple(tuple: readonly unknown[]): string {
  if (Object.getOwnPropertyDescriptor(JSON, 'stringify')?.value !== originalStringify
    || Object.getOwnPropertyDescriptor(Array.prototype, 'join')?.value !== originalJoin) {
    return hashContextRevision("semantic", tuple)
  }
  const hash = revisionHash("semantic")
  let batch = ""
  for (const part of streamJsonData(tuple, { lexical: true, dataOnly: true })) {
    batch += part
    if (batch.length >= semanticBatchUnits) {
      hash.update(batch)
      batch = ""
    }
  }
  return hash.update(batch).digest("hex")
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
    ? hashOwnedSemanticTuple(semantic)
    : contextRevision("semantic", semantic)
}
