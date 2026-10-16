import { validAcceptedRequest, type AcceptedRequestAttributionV1 } from "./attribution.ts"
import type { SessionEventView as SessionEvent } from "../managed/types.ts"

export interface InputProvenance {
  kind: "human" | "plugin" | "child-report" | "inherited" | "unknown"
  authority: "request" | "observation" | "unknown"
  scope: "turn" | "session"
  producer: string
  originSessionId?: string
}
export type ConversationSemanticsEvent = { type: "conversation/semantics"; version: 1; seq?: number; mode: "accepted-exchange-v1" }
export type ExchangeAcceptedEventV1 = {
  type: "model/exchange-accepted"; version: 1; seq?: number
  exchangeId: string; actionId: string; attemptId: string
  stepStartSeq: number; assistantSeq: number; callSeqs: readonly number[]
}
export type ExchangeAcceptedEventV2 = Omit<ExchangeAcceptedEventV1, "version"> & { version: 2; request: AcceptedRequestAttributionV1 }
export type ExchangeAcceptedEvent = ExchangeAcceptedEventV1 | ExchangeAcceptedEventV2
export function conversationFormatError(reason: string): never {
  throw Object.assign(new Error(`invalid conversation format: ${reason}`), { code: "SESSION_CONVERSATION_FORMAT" })
}
export const conversationId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256
export const conversationSeq = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0
function fields(value: object, allowed: readonly string[]): boolean { return Object.keys(value).every(key => allowed.includes(key)) }
export function validInputProvenance(value: unknown): value is InputProvenance {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const p = value as InputProvenance
  const authority = p.kind === "human" ? "request" : p.kind === "unknown" ? "unknown" : ["plugin", "child-report", "inherited"].includes(p.kind) ? "observation" : undefined
  return authority !== undefined && p.authority === authority && ["turn", "session"].includes(p.scope)
    && conversationId(p.producer) && (p.originSessionId === undefined || conversationId(p.originSessionId))
    && fields(p, ["kind", "authority", "scope", "producer", "originSessionId"])
}
/** New fields are version-fenced; existing event payload policies stay owned by their validators. */
export function validateConversationEventShape(event: SessionEvent, formatVersion: number): void {
  validateNativeWitness(event, formatVersion)
  const e = event as SessionEvent & { provenance?: unknown; actionId?: unknown; attemptId?: unknown }
  if ((event.type === "model/exchange-accepted" || event.type === "context/usage") && event.version === 2 && formatVersion < 4) conversationFormatError("fields require format 4")
  const explicit = event.type === "conversation/semantics" || event.type === "model/exchange-accepted"
  if ((explicit || e.provenance !== undefined || e.actionId !== undefined || e.attemptId !== undefined || event.type === "user/message" && event.input?.provenance !== undefined) && formatVersion < 3) conversationFormatError("fields require format 3")
  if (e.provenance !== undefined && (!["agent/input/admitted", "user/message", "subagent/inbox"].includes(event.type) || !validInputProvenance(e.provenance))) conversationFormatError("invalid input provenance")
  if (event.type === "user/message" && event.input?.provenance !== undefined && !validInputProvenance(event.input.provenance)) conversationFormatError("invalid promoted input provenance")
  if (e.actionId !== undefined || e.attemptId !== undefined) {
    if (event.type !== "step/start" && event.type !== "model/exchange-accepted" || !conversationId(e.actionId) || !conversationId(e.attemptId)) conversationFormatError("invalid attempt identity")
  }
  if (!explicit) return
  if ((event.version !== 1 && !(event.type === "model/exchange-accepted" && event.version === 2)) || event.seq !== undefined && !conversationSeq(event.seq)) conversationFormatError("invalid envelope")
  if (event.type === "conversation/semantics") {
    if (event.mode !== "accepted-exchange-v1" || !fields(event, ["type", "version", "seq", "mode", "ignorable"])) conversationFormatError("invalid semantics fence")
  } else if (new TextEncoder().encode(JSON.stringify(event)).byteLength > 4096 || event.version === 2 && !validAcceptedRequest(event.request) || !conversationId(event.exchangeId) || !conversationId(event.actionId) || !conversationId(event.attemptId)
    || !conversationSeq(event.stepStartSeq) || !conversationSeq(event.assistantSeq)
    || !Array.isArray(event.callSeqs) || !event.callSeqs.every(conversationSeq) || new Set(event.callSeqs).size !== event.callSeqs.length
    || !fields(event, ["type", "version", "seq", "exchangeId", "actionId", "attemptId", "stepStartSeq", "assistantSeq", "callSeqs", "ignorable", ...(event.version === 2 ? ["request"] : [])])) conversationFormatError("invalid acceptance payload")
}
import { validateNativeWitness } from '../projection/native-witness.ts'
