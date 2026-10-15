import type { Session } from "../events/types.ts"
import type { ConversationDiagnostic, ConversationProvenance, ConversationSourceRef } from "./types.ts"

/** Source coordinates belong to the original archive, even for a prefix view. */
export function conversationSources(session: Session, ownerSessionId: string | undefined, diagnostics: ConversationDiagnostic[]) {
  const counts = new Map<number, number>()
  const valid = (seq: unknown): seq is number => typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 0
  for (const event of session.events) if (valid(event.seq)) counts.set(event.seq, (counts.get(event.seq) ?? 0) + 1)
  const cache = new Map<string, ConversationSourceRef>()
  const fenceIndex = session.events.findIndex(event => event.type === "conversation/semantics")
  const ref = (eventIndex: number, part: string): ConversationSourceRef => {
    const key = `${eventIndex}:${part}`
    let source = cache.get(key)
    if (source) return source
    const seq = session.events[eventIndex]!.seq
    const addressable = valid(seq) && counts.get(seq) === 1
    source = Object.freeze({ id: JSON.stringify([ownerSessionId ?? null, addressable ? seq : `event:${eventIndex}`, part]), eventIndex, ...(addressable ? { seq } : {}), part, addressable })
    cache.set(key, source)
    return source
  }
  for (let index = 0; index < session.events.length; index++) {
    const seq = session.events[index]!.seq
    const code = seq === undefined ? "missing-source-seq" : !valid(seq) ? "invalid-source-seq" : counts.get(seq)! > 1 ? "duplicate-source-seq" : undefined
    if (code) diagnostics.push({ code, sourceIds: [ref(index, "event").id] })
  }
  const provenance = (eventIndex: number, part: string, admissionIndex?: number): ConversationProvenance => {
    const event = session.events[eventIndex]!
    const source = ref(eventIndex, part)
    const evidence = [source]
    const admission = admissionIndex === undefined ? undefined : session.events[admissionIndex]
    if (admissionIndex !== undefined) evidence.push(ref(admissionIndex, "admission"))
    let kind: ConversationProvenance["kind"] = "unknown"
    let authority: ConversationProvenance["authority"] = "unknown"
    let scope: ConversationProvenance["scope"] = "turn"
    let producer: string | undefined
    let originSessionId: string | undefined
    if (event.type === "compaction/summary") { kind = "summary"; authority = "derived" }
    else if (event.type === "assistant/message" || event.type === "tool/call") { kind = "model"; authority = "observation" }
    else if (event.type === "tool/result") { kind = "tool"; authority = "observation"; producer = event.name }
    else if (event.type === "user/message") {
      const admitted = admission?.type === "agent/input/admitted" ? admission : undefined
      const matching = admitted && event.input?.inputId === admitted.inputId && event.text === admitted.text && event.input.intent === admitted.intent
      const descriptor = matching ? admitted.provenance : event.provenance ?? event.input?.provenance
      const synthetic = event.input?.synthetic ?? admitted?.synthetic
      if (synthetic) { scope = synthetic.scope; producer = synthetic.description }
      if (descriptor) { ({ kind, authority, scope, producer, originSessionId } = descriptor) }
      if (event.source || event.internal || event.input?.intent === "system" || admitted?.intent === "system" || synthetic) {
        kind = descriptor && descriptor.kind !== "human" ? descriptor.kind : synthetic?.display?.kind === "task" || synthetic?.display?.kind === "team-result" ? "child-report" : event.source ? "plugin" : "unknown"
        authority = "observation"
        producer = event.source?.plugin ?? producer
      } else if (!descriptor && matching && (fenceIndex < 0 || admissionIndex! < fenceIndex) && !isInherited(admissionIndex!) && source.addressable && ref(admissionIndex!, "admission").addressable) {
        kind = "human"; authority = "request"
      }
      if (event.input && !matching) diagnostics.push({ code: "missing-admission", sourceIds: [source.id] })
    }
    const inherited = isInherited(eventIndex) || admissionIndex !== undefined && isInherited(admissionIndex) && admission?.type === "agent/input/admitted" && admission.provenance !== undefined
    return Object.freeze({ kind: inherited ? "inherited" : kind, authority: inherited ? "observation" : authority, scope, evidence: Object.freeze(evidence), ...(producer === undefined ? {} : { producer }), ...(inherited ? { originSessionId: session.header!.parentSession } : originSessionId === undefined ? {} : { originSessionId }) })
  }
  function isInherited(index: number): boolean {
    return session.header?.parentSession !== undefined && index < (session.header.seedLength ?? 0)
  }
  return { ref, provenance }
}

export type ConversationSources = ReturnType<typeof conversationSources>
