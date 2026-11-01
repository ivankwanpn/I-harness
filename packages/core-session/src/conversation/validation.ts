import { validateUsageFact, type AcceptanceFact, type UsageAnchorFact } from "./usage-validation.ts"
import type { SessionEventView as SessionEvent } from "../managed/types.ts"
import { CURRENT_FORMAT_VERSION } from '../events/types.ts'
import { validateRuntimeContextDiscriminant } from '../events/runtime-context.ts'
import { conversationFormatError as fail, conversationSeq, validateConversationEventShape, validateSemanticSourceEventShape } from "../events/conversation.ts"
import type { projectHistory } from './history/replacements.ts'
import { createDeliveryIndex, type DeliveryReadIndex } from './delivery.ts'
import { createHistoryIndex } from './history/index.ts'
import { createGenerationIndex, type GenerationHistoryScope, type GenerationActionState } from './generation.ts'
import { createInputPreparationIndex } from './input-preparation.ts'
import { createSoftReductionIndex } from './soft-reduction.ts'
import { bootstrapStaging, semanticSourceStructure, conversationScopeKey, validateBootstrapReadiness, createBootstrapReadinessScan } from './bootstrap-validation.ts'
export { conversationScopeKey } from './bootstrap-validation.ts'

interface Address { index: number; type: SessionEvent["type"]; step?: number; callId?: string; actionId?: string; attemptId?: string; ambiguous?: boolean }

interface ConversationScanStage {
  advance(event: SessionEvent): void;
  dependencies(event: SessionEvent): readonly number[];
  finish(): ReturnType<ConversationValidationIndex['stage']>;
}
type ConversationScanBegin = (readCurrent?: (index: number) => SessionEvent | undefined, readStaged?: (index: number) => SessionEvent | undefined) => ConversationScanStage;
interface StageOptions { readCurrentEvent?: (index: number) => SessionEvent | undefined }
interface Step { failed: boolean; accepted: boolean; calls: number }
export interface ConversationValidationIndex {
  readonly generationScope: string
  readonly formatVersion: number
  readonly eventCount: number
  readonly semanticsStartSeq: number | undefined
  stage(events: readonly SessionEvent[], options?: StageOptions): { commit(): void; history(): ReturnType<typeof projectHistory> }
  history(throughSeq?: number): ReturnType<typeof projectHistory>
  semanticSeedResultRefs(): readonly import('../results/types.ts').ManagedArtifactRef[]
  iterateSelectedResultRefs(): Iterable<import('../results/types.ts').ManagedArtifactRef>
  resultFacts(): readonly import('./history/facts.ts').HistoryFact[]
  replacementDependencies(): ReadonlyMap<number, ReadonlySet<number>>
  softReduction(ownerSessionId: string): import('./soft-reduction.ts').SoftReductionState
}
const deliveryObservations = new WeakMap<ConversationValidationIndex, DeliveryReadIndex>()
const generationObservations = new WeakMap<ConversationValidationIndex, () => readonly GenerationActionState[]>()
export function readConversationGenerations(index: ConversationValidationIndex) { return generationObservations.get(index)?.() }
/** Private read link, installed only by this index's actual construction. */
export function readConversationDeliveries(index: ConversationValidationIndex): DeliveryReadIndex | undefined { return deliveryObservations.get(index) }

/** Derived structural facts only: no prompt, args, native sidecars or outputs. */
export function createConversationValidationIndex(events: readonly SessionEvent[] = [], options: { formatVersion: number; header?: GenerationHistoryScope } = { formatVersion: CURRENT_FORMAT_VERSION }): ConversationValidationIndex {
  return createConversationIndex(events, undefined, options.formatVersion, options.header)
}

/** Internal append-owner port: re-read referenced structural fields, without retaining a second archive. */
export function createConversationIndex(events: readonly SessionEvent[], read?: (index: number) => SessionEvent | undefined, formatVersion = CURRENT_FORMAT_VERSION, header: GenerationHistoryScope = {}): ConversationValidationIndex {
  return conversationIndex(events, read, formatVersion, header)
}
/** Package-private composition entry; never exported by the public facade. */
export function createBootstrapConversationIndex(events: readonly SessionEvent[], read: ((index: number) => SessionEvent | undefined) | undefined, formatVersion: number, header: GenerationHistoryScope): ConversationValidationIndex {
  return conversationIndex(events, read, formatVersion, header, bootstrapStaging)
}
export function createSemanticSourceConversationIndex(events: readonly SessionEvent[], formatVersion: number, header: GenerationHistoryScope = {}): ConversationValidationIndex {
  return conversationIndex(events, undefined, formatVersion, header, semanticSourceStructure)
}
function conversationIndex(events: readonly SessionEvent[], read: ((index: number) => SessionEvent | undefined) | undefined, formatVersion: number, header: GenerationHistoryScope, capability?: typeof bootstrapStaging | typeof semanticSourceStructure, scan?: (begin: ConversationScanBegin) => void): ConversationValidationIndex {
  const validateShape = capability === semanticSourceStructure ? validateSemanticSourceEventShape : validateConversationEventShape
  const acceptances = new Map<number, AcceptanceFact>()
  const completions = new Map<number, string>()
  const anchors = new Map<string, UsageAnchorFact>()
  const addresses = new Map<number, Address>()
  const steps = new Map<number, Step>()
  const exchanges = new Set<string>()
  const attempts = new Set<string>()
  const acceptedCalls = new Set<number>()
  const callsById = new Map<string, number | null>()
  const history = createHistoryIndex(formatVersion, validateShape, header.parentSession !== undefined || header.semanticSeed !== undefined ? header.seedLength ?? 0 : 0)
  const scope = Object.freeze({ sessionId: header.sessionId, parentSession: header.parentSession, seedLength: header.seedLength,
    ...(header.semanticSeed ? { semanticSeed: Object.freeze({ ...header.semanticSeed }) } : {}) })
  const delivery = createDeliveryIndex(scope, capability === semanticSourceStructure ? semanticSourceStructure : undefined)
  let deliveryOrigins: import("./delivery.ts").DeliveryOriginLookup | undefined
  const generation = createGenerationIndex(scope, { lookupActionOrigin: open => deliveryOrigins?.lookupActionOrigin(open) })
  const preparations = createInputPreparationIndex(scope, capability === semanticSourceStructure ? semanticSourceStructure : undefined)
  const soft = createSoftReductionIndex(scope)
  let count = 0, revision = 0
  let fence: number | undefined, activeStep: number | undefined
  const verify = (seq: number, target: Address, readCurrent = read) => {
    if (!readCurrent || target.index >= count) return
    const actual = readCurrent(target.index)
    if (!actual || actual.seq !== seq || actual.type !== target.type
      || actual.type === "step/start" && (actual.actionId !== target.actionId || actual.attemptId !== target.attemptId)
      || actual.type === "tool/call" && actual.callId !== target.callId) fail("referenced structure was mutated")
  }

  function beginStage(readCurrent?: (index: number) => SessionEvent | undefined, readStaged = readCurrent ?? (() => undefined)): ConversationScanStage {
      const stagedHistory = history.stage(readCurrent)
      const stagedDelivery = delivery.stage()
      deliveryOrigins = stagedDelivery
      const stagedGeneration = generation.stage()
      const stagedSoft = soft.stage()
      const stagedPreparations = preparations.stage(seq => seq >= count ? readStaged(seq) : readCurrent?.(seq) ?? events[seq], stagedGeneration.action)
      const newAcceptances = new Map<number, AcceptanceFact>()
      const newCompletions = new Map<number, string>()
      const newAnchors = new Map<string, UsageAnchorFact>()
      const epoch = revision
      let nextFence = fence, nextStep = activeStep
      const newAddresses = new Map<number, Address>(), newSteps = new Map<number, Step>()
      const newExchanges = new Set<string>(), newAttempts = new Set<string>(), newAccepted = new Set<number>()
      const newCalls = new Map<string, number | null>()
      const lookup = (seq: number) => newAddresses.get(seq) ?? addresses.get(seq)
      const step = (seq: number) => {
        let value = newSteps.get(seq)
        if (!value) { const old = steps.get(seq); if (!old) fail("missing physical step"); value = { ...old }; newSteps.set(seq, value) }
        return value
      }

    let stagedLength = 0;
    const advance = (event: SessionEvent) => {
      validateRuntimeContextDiscriminant(event, formatVersion);
      if (capability === semanticSourceStructure) validateSemanticSourceEventShape(event, formatVersion);
      const offset = stagedLength++;

        validateShape(event, formatVersion)
        stagedDelivery.advance(event)
        stagedGeneration.advance(event)
        stagedSoft.advance(event)
        stagedPreparations.advance(event)
        stagedHistory.advance(event)
        if ((event.type === "conversation/semantics" || event.type === "model/exchange-accepted") && !conversationSeq(event.seq)) fail("unaddressable explicit record")
        const position = count + offset
        if (event.type === "conversation/semantics") {
          if (nextFence !== undefined) fail("duplicate semantics fence")
          nextFence = event.seq!
          nextStep = undefined
        }
        if (event.type === "step/start") {
          nextStep = position
          newSteps.set(position, { failed: false, accepted: false, calls: 0 })
          if (nextFence !== undefined) {
            if (!event.actionId || !event.attemptId) fail("missing physical attempt identity")
            const identity = JSON.stringify([event.actionId, event.attemptId])
            if (attempts.has(identity) || newAttempts.has(identity)) fail("duplicate physical attempt")
            newAttempts.add(identity)
          }
        }
        if (event.type === "model/exchange-accepted") {
          if (nextFence === undefined) fail("acceptance without fence")
          if (exchanges.has(event.exchangeId) || newExchanges.has(event.exchangeId)) fail("duplicate exchange identity")
          const reference = (seq: number, kind: SessionEvent["type"]): Address => {
            const target = lookup(seq)
            if (!target || target.ambiguous || target.type !== kind || target.index >= position || seq >= event.seq! || seq <= nextFence!) fail("invalid acceptance reference")
            verify(seq, target, readCurrent)
            return target
          }
          const start = reference(event.stepStartSeq, "step/start")
          const assistant = reference(event.assistantSeq, "assistant/message")
          if (event.assistantSeq <= event.stepStartSeq || event.callSeqs.some(seq => seq <= event.stepStartSeq)) fail("reference precedes physical step")
          if (start.actionId !== event.actionId || start.attemptId !== event.attemptId || assistant.step !== start.index || nextStep !== start.index || assistant.index <= start.index) fail("acceptance crosses physical attempt")
          const fact = step(start.index)
          if (fact.failed || fact.accepted) fail("attempt failed or already accepted")
          let last = start.index
          if (fact.calls !== event.callSeqs.length) fail("incomplete accepted calls")
          for (const seq of event.callSeqs) {
            const call = reference(seq, "tool/call")
            if (call.step !== start.index || call.index <= last) fail("accepted call order or step mismatch")
            last = call.index
            newAccepted.add(seq)
          }
          if (event.version === 2) newAcceptances.set(event.seq!, { index: position, exchangeId: event.exchangeId, actionId: event.actionId, attemptId: event.attemptId, stepStartSeq: event.stepStartSeq, assistantSeq: event.assistantSeq, callSeqs: JSON.stringify(event.callSeqs), request: JSON.parse(JSON.stringify(event.request)) })
          fact.accepted = true
          newExchanges.add(event.exchangeId)
        }
        if (event.type === "context/usage" && event.version === 2) {
          const anchorId = event.op === "sample" ? event.checkpoint.anchorId : event.anchorId
          const seq = event.op === "sample" ? event.checkpoint.accepted.acceptedSeq : undefined
          const accepted = seq === undefined ? undefined : newAcceptances.get(seq) ?? acceptances.get(seq)
          const actual = accepted && (accepted.index < count ? readCurrent?.(accepted.index) : readStaged(accepted.index))
          const fact = validateUsageFact(event, position, {
            accepted,
            actual,
            requireCurrent: !!readCurrent,
            anchor: newAnchors.get(anchorId) ?? anchors.get(anchorId),
            completedAnchorId: seq === undefined ? undefined : newCompletions.get(seq) ?? completions.get(seq),
          })
          if (accepted && event.op === "sample") {
            const references: [number, SessionEvent["type"]][] = [
              [accepted.stepStartSeq, "step/start"],
              [accepted.assistantSeq, "assistant/message"],
              ...JSON.parse(accepted.callSeqs).map((seq: number) => [seq, "tool/call"] as [number, SessionEvent["type"]]),
            ]
            for (const [seq, kind] of references) {
              const target = lookup(seq)
              if (!target
                || target.ambiguous
                || target.type !== kind
                || target.index >= accepted.index) fail("invalid acceptance reference")
              verify(seq, target, readCurrent)
            }
          }
          newAnchors.set(anchorId, fact)
          if (seq !== undefined) newCompletions.set(seq, anchorId)
        }
        if (event.type === "tool/dispatch" && nextFence !== undefined) {
          const seq = event.eventSeq ?? (newCalls.has(event.callId) ? newCalls.get(event.callId) : callsById.get(event.callId))
          const call = seq == null ? undefined : lookup(seq)
          if (seq == null || !call || call.ambiguous || call.callId !== event.callId || !(acceptedCalls.has(seq) || newAccepted.has(seq))) fail("dispatch without accepted call")
          verify(seq, call, readCurrent)
        }
        if (event.type === "step/failed" && nextStep !== undefined) step(nextStep).failed = true
        if (event.type === "tool/call" && nextStep !== undefined) step(nextStep).calls++
        if (conversationSeq(event.seq)) {
          const prior = lookup(event.seq)
          newAddresses.set(event.seq, prior ? { ...prior, ambiguous: true } : {
            index: position, type: event.type, ...(nextStep === undefined ? {} : { step: nextStep }),
            ...(event.type === "step/start" ? { actionId: event.actionId, attemptId: event.attemptId } : {}),
            ...(event.type === "tool/call" ? { callId: event.callId } : {}),
          })
          if (prior && (nextFence !== undefined || newAccepted.has(event.seq) || acceptedCalls.has(event.seq))) fail("duplicate explicit address")
          if (event.type === "tool/call") newCalls.set(event.callId, newCalls.has(event.callId) || callsById.has(event.callId) ? null : event.seq)
        } else if (nextFence !== undefined) fail("unaddressable explicit event")
        if (event.type === "step/end" || event.type === "turn/start" || event.type === "turn/end") nextStep = undefined

    };
    return { advance, dependencies(event) {
      const required = new Set(stagedPreparations.dependencies(event));
      if (event.type === 'context/usage' && event.version === 2 && event.op === 'sample') {
        const actual = newAcceptances.get(event.checkpoint.accepted.acceptedSeq) ?? acceptances.get(event.checkpoint.accepted.acceptedSeq);
        if (actual) required.add(actual.index);
      }
      return [...required];
    }, finish() {

      stagedDelivery.validate()
      stagedGeneration.validate()
      stagedPreparations.validate()
      let committed = false
      const assertCurrent = () => {
        if (committed) fail("consumed staged suffix")
        if (epoch !== revision) fail("stale staged suffix")
      }
      return { history() {
        assertCurrent()
        return stagedHistory.history()
      }, commit() {
        if (committed) return
        assertCurrent()
        for (const [key, value] of newCompletions) completions.set(key, value)
        for (const [key, value] of newAcceptances) acceptances.set(key, value)
        for (const [key, value] of newAnchors) anchors.set(key, value)
        for (const [key, value] of newAddresses) addresses.set(key, value)
        for (const [key, value] of newSteps) steps.set(key, value)
        for (const [key, value] of newCalls) callsById.set(key, value)
        stagedHistory.commit()
        stagedDelivery.commit()
        stagedGeneration.commit()
        stagedSoft.commit()
        stagedPreparations.commit()
        for (const id of newExchanges) exchanges.add(id)
        for (const id of newAttempts) attempts.add(id)
        for (const seq of newAccepted) acceptedCalls.add(seq)
        count += stagedLength; fence = nextFence; activeStep = nextStep; revision++; committed = true
      } }

    } };
  }

  const index: ConversationValidationIndex = {
    generationScope: conversationScopeKey(scope),
    get formatVersion() { return formatVersion },
    get eventCount() { return count },
    get semanticsStartSeq() { return fence },
    history: history.history,
    semanticSeedResultRefs: () => [...index.iterateSelectedResultRefs()],
    *iterateSelectedResultRefs() {
      if (scope.semanticSeed?.version === 3 && count < scope.semanticSeed.seedLength + 1 + (scope.semanticSeed.initialInputId === undefined ? 0 : 1)) return
      yield* history.iterateSelectedResultRefs()
    },
    resultFacts: history.resultFacts,
    replacementDependencies: history.dependencies,
    softReduction: soft.read,
    stage(suffix, options) {
      for (const event of suffix) validateRuntimeContextDiscriminant(event, formatVersion);
      if (capability === semanticSourceStructure) for (const event of suffix) validateSemanticSourceEventShape(event, formatVersion);
      const readCurrent = options?.readCurrentEvent ?? read;
      const prefixLength = scope.semanticSeed ? Math.min(count, scope.semanticSeed.seedLength + 1 + (scope.semanticSeed.initialInputId === undefined ? 0 : 1)) : 0;
      validateBootstrapReadiness([...Array.from({ length: prefixLength }, (_, index) => readCurrent?.(index) ?? events[index]!), ...suffix], formatVersion, scope, capability);
      const staged = beginStage(readCurrent, position => suffix[position - count]);
      for (const event of suffix) staged.advance(event);
      return staged.finish();
    },
  }
  if (scan) scan(beginStage); else index.stage(events).commit()
  if (capability !== semanticSourceStructure) deliveryObservations.set(index, delivery.readIndex())
  if (capability !== semanticSourceStructure) generationObservations.set(index, generation.read)
  return index
}

export function validateConversationHistory(events: readonly SessionEvent[], formatVersion: number, header?: GenerationHistoryScope): void {
  for (const event of events) validateConversationEventShape(event, formatVersion)
  createConversationValidationIndex(events, { formatVersion, header })
}

/** Only nominal completed validation candidates cross into original managed
 * construction. Read consumers never receive the mutable validation index. */
const scanCandidates = new WeakMap<object, { index: ConversationValidationIndex; consumed: boolean }>()
export function inspectConversationValidationScan(candidate: object) {
  const record = scanCandidates.get(candidate)
  if (!record || record.consumed) throw new TypeError('Invalid or consumed conversation validation scan')
  return { eventCount: record.index.eventCount, history: record.index.history(), resultFacts: record.index.resultFacts() }
}
/** Constructor-private transfer, used by the original restored state owner. */
export function takeConversationValidationScan(candidate: object): ConversationValidationIndex {
  const record = scanCandidates.get(candidate)
  if (!record || record.consumed) throw new TypeError('Invalid or consumed conversation validation scan')
  record.consumed = true
  return record.index
}
export function createConversationValidationScan(options: {
  formatVersion: number; header?: GenerationHistoryScope;
  readEvent(ordinal: number): Promise<SessionEvent>
}) {
  let begin!: ConversationScanBegin
  const header = options.header ?? {}, available = new Map<number, SessionEvent>()
  const index = conversationIndex([], undefined, options.formatVersion, header, undefined, value => { begin = value })
  const staged = begin(position => available.get(position), position => available.get(position))
  const bootstrap = createBootstrapReadinessScan(options.formatVersion, header)
  let ordinal = 0, terminal = false, failed = false, flight = false
  return {
    async push(unit: readonly SessionEvent[]) {
      if (terminal || failed || flight) throw new TypeError('Conversation scan unavailable')
      flight = true
      try {
        for (const event of unit) {
          validateRuntimeContextDiscriminant(event, options.formatVersion)
          validateConversationEventShape(event, options.formatVersion)
          available.set(ordinal, event)
          for (const dependency of staged.dependencies(event)) if (dependency < ordinal && !available.has(dependency)) available.set(dependency, await options.readEvent(dependency))
          bootstrap.advance(event)
          staged.advance(event)
          ordinal++
          available.clear()
        }
      } catch (error) { failed = true; throw error } finally { available.clear(); flight = false }
    },
    finish(): object {
      if (terminal || failed || flight) throw new TypeError('Conversation scan unavailable')
      terminal = true
      bootstrap.finish()
      staged.finish().commit()
      const candidate = Object.freeze({})
      scanCandidates.set(candidate, { index, consumed: false })
      return candidate
    },
  }
}
