import { eventArchive, type ConversationEventArchive } from './archive.ts'
import type { SessionView as Session } from "../managed/types.ts"
import type { ConversationDiagnostic, ConversationProvenance, ConversationSourceRef } from "./types.ts"

/** Source coordinates belong to the original archive, even for a prefix view. */
export function archiveConversationSources(archive: ConversationEventArchive, ownerSessionId: string | undefined, diagnostics: ConversationDiagnostic[], options: { header?: Session['header']; candidate?: { id: string; baseCount: number } } = {}) {
  const counts = new Map<number, number>()
  const valid = (seq: unknown): seq is number => typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 0
  const positions = new Map<number, number>()
  let fenceIndex = -1
  for (let index = 0; index < archive.length; index++) {
    const event = archive.get(index)
    if (valid(event.seq) && !(options.candidate && index >= options.candidate.baseCount)) {
      counts.set(event.seq, (counts.get(event.seq) ?? 0) + 1)
      if (!positions.has(event.seq)) positions.set(event.seq, index)
    }
    if (fenceIndex < 0 && event.type === "conversation/semantics") fenceIndex = index
  }
  const cache = new Map<string, ConversationSourceRef>()
  const ref = (eventIndex: number, part: string): ConversationSourceRef => {
    const key = `${eventIndex}:${part}`
    let source = cache.get(key)
    if (source) return source
    const seq = archive.get(eventIndex).seq
    const prospective = options.candidate !== undefined && eventIndex >= options.candidate.baseCount
    const addressable = !prospective && valid(seq) && counts.get(seq) === 1
    const coordinate = prospective ? `candidate:${options.candidate!.id}:${eventIndex - options.candidate!.baseCount}` : addressable ? seq : `event:${eventIndex}`
    source = Object.freeze({ id: JSON.stringify([ownerSessionId ?? null, coordinate, part]), eventIndex, ...(addressable ? { seq } : {}), part, addressable })
    cache.set(key, source)
    return source
  }
  for (let index = 0; index < archive.length; index++) {
    const seq = archive.get(index).seq
    const code = seq === undefined ? "missing-source-seq" : !valid(seq) ? "invalid-source-seq" : counts.get(seq)! > 1 ? "duplicate-source-seq" : undefined
    if (code && !(options.candidate && index >= options.candidate.baseCount)) diagnostics.push({ code, sourceIds: [ref(index, "event").id] })
  }
  const provenance = (eventIndex: number, part: string, admissionIndex?: number): ConversationProvenance => {
    const event = archive.get(eventIndex)
    const source = ref(eventIndex, part)
    const evidence = [source]
    const admission = admissionIndex === undefined ? undefined : archive.get(admissionIndex)
    if (admissionIndex !== undefined) evidence.push(ref(admissionIndex, "admission"))
    let kind: ConversationProvenance["kind"] = "unknown"
    let authority: ConversationProvenance["authority"] = "unknown"
    let scope: ConversationProvenance["scope"] = "turn"
    let producer: string | undefined
    let originSessionId: string | undefined
    if (event.type === "compaction/summary" || event.type === 'compaction/replacement') { kind = "summary"; authority = "derived" }
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
    return Object.freeze({ kind: inherited ? "inherited" : kind, authority: inherited ? "observation" : authority, scope, evidence: Object.freeze(evidence), ...(producer === undefined ? {} : { producer }), ...(inherited ? { originSessionId: options.header!.parentSession } : originSessionId === undefined ? {} : { originSessionId }) })
  }
  function isInherited(index: number): boolean {
    return options.header?.parentSession !== undefined && index < (options.header.seedLength ?? 0)
  }
  return { ref, provenance, indexOfSeq: (seq: number) => positions.get(seq) ?? -1 }
}

/** Existing Session consumer entry, backed by the same archive source owner. */
export function conversationSources(session: Session, ownerSessionId: string | undefined, diagnostics: ConversationDiagnostic[]) {
  return archiveConversationSources(eventArchive(session.events), ownerSessionId, diagnostics, { header: session.header })
}

export type ConversationSources = Pick<ReturnType<typeof conversationSources>, 'ref' | 'provenance'>
