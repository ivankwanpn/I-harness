import type { LLMMessage } from "../projection/types.ts"

export interface ConversationSourceRef {
  id: string
  eventIndex: number
  seq?: number
  part: string
  addressable: boolean
}

export interface ConversationProvenance {
  kind: "human" | "plugin" | "tool" | "child-report" | "model" | "summary" | "inherited" | "unknown"
  authority: "request" | "observation" | "derived" | "unknown"
  scope: "turn" | "session"
  evidence: readonly ConversationSourceRef[]
  producer?: string
  originSessionId?: string
}

export interface ConversationCall {
  callId: string
  name: string
  call?: ConversationSourceRef
  result?: ConversationSourceRef
  dispatch?: ConversationSourceRef
  outcome: "pending" | "success" | "error" | "not-dispatched" | "unknown"
}

export interface ConversationItem {
  readonly ref?: import('../events/replacement.ts').ConversationItemRef
  readonly replacement?: Pick<import('../events/replacement.ts').ContextReplacementRecordV1, 'replacementId' | 'coverage' | 'insertBefore'>
  id: string
  kind: "input" | "summary" | "exchange" | "legacy-fragment"
  sources: readonly ConversationSourceRef[]
  provenance: ConversationProvenance
  messages: readonly LLMMessage[]
  exchange?: {
    id: string
    step?: ConversationSourceRef
    acceptance: "legacy-inferred" | "explicit"
    state: "open" | "closed" | "unresolved"
    calls: readonly ConversationCall[]
  }
}

export interface ConversationDiagnostic {
  code: "orphan-result" | "duplicate-call-id" | "duplicate-source-seq" | "missing-source-seq" |
    "invalid-source-seq" | "missing-admission" | "partial-exchange-shadow" | "unaccepted-dispatch"
  sourceIds: readonly string[]
}

export interface ConversationProjection {
  version: 1
  ownerSessionId?: string
  archiveEventCount: number
  throughSeq?: number
  items: readonly ConversationItem[]
  diagnostics: readonly ConversationDiagnostic[]
}
