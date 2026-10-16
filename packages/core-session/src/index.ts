// Stable package facade. Internal owners import each other directly.
export { Inbox, SYSTEM_INPUT_PLUGIN } from "./inbox.ts"
export type { AdmittedInput, PendingInput, InputDelivery, InputIntent, InputSynthetic, InputDisplay, UserMessageInput } from "./inbox.ts"

export { CURRENT_FORMAT_VERSION } from "./events/types.ts"
export type { InputProvenance, ConversationSemanticsEvent, ExchangeAcceptedEvent } from "./events/conversation.ts"
export { validateConversationEventShape } from "./events/conversation.ts"
export { validNativeProducerWitness } from './projection/native-witness.ts'
export { createConversationValidationIndex, validateConversationHistory } from "./conversation/validation.ts"
export type { ConversationValidationIndex } from "./conversation/validation.ts"
export type {
  ModelRetryInfo,
  ModelActivityInfo,
  SessionEvent,
  TodoItemStatus,
  TodoItem,
  GoalPhase,
  GoalOperation,
  GoalRef,
  GoalSnapshot,
  SessionHeader,
  Session,
} from "./events/types.ts"
export { createSession, append } from "./events/append.ts"
export type { ContextBindingMetadata, ContextUsageCheckpoint, RequestBudgetSnapshot, BudgetRead, ContextRecoveryFacts, ContextEvent } from "./events/context.ts"
export { validContextEvent, isContextEventType } from "./events/context.ts"
export { deriveContextBudget, deriveContextRecovery } from "./projection/context.ts"
export { contextStateFromBudget, readSessionContextState, type SessionContextState } from "./context-state.ts"
export { subscribe, publishTransient } from "./events/subscription.ts"

export { IMAGE_MEDIA_TYPES, MAX_IMAGE_BYTES_PER_MESSAGE, validateImages } from "./images.ts"
export type { ImageMediaType, ImageInput } from "./images.ts"
export type { ProviderThinkingBlock, ProviderBlockOrderEntry, ProviderContinuation, LLMContentPart, LLMMessage } from "./projection/types.ts"
export { renderPruneSubstitute, derivePruneSubstitutes } from "./projection/pruning.ts"
export type { PruneRecord } from "./projection/pruning.ts"
export { rewindCuts } from "./projection/rewind.ts"
export type { RewindCut } from "./projection/rewind.ts"
export { deriveProjectionRewrite } from "./projection/rewrite.ts"
export { deriveMessagesUpTo, deriveMessages } from "./projection/messages.ts"
export { projectConversation } from "./conversation/project.ts"
export { readConversationState } from "./conversation/state.ts"
export type { ConversationState } from "./conversation/state.ts"
export type { ConversationPayloadCapture } from "./conversation/payload.ts"
export { renderConversation } from "./conversation/render.ts"
export { copyConversationData } from "./conversation/render.ts"
export type { ConversationSourceRef, ConversationProvenance, ConversationCall, ConversationItem, ConversationDiagnostic, ConversationProjection } from "./conversation/types.ts"
export { deriveSearchText } from "./projection/search.ts"
export { derivePlanMode } from "./projection/plan.ts"
export type { PlanModeView } from "./projection/plan.ts"
export { deriveSessionTitle } from "./projection/title.ts"
export type { SessionTitleView } from "./projection/title.ts"

export { toJSONL, assertVersion, fromJSONL, migrate } from "./serialization/jsonl.ts"
export { stringifyJsonData, canonicalJsonData } from "./serialization/json-data.ts"

export type { AcceptedRequestAttributionV1, ContextUsageCheckpointV2, ContextUsageEventV2, CalibrationRetirementReason } from "./events/attribution.ts"
export { validAcceptedRequest, sameAcceptedRequest } from "./events/attribution.ts"
export type { ExchangeAcceptedEventV2 } from "./events/conversation.ts"

export { contextUsageAnchorId } from "./events/usage-anchor.ts"
