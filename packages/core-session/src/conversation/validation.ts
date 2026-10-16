import { validateUsageFact, type AcceptanceFact, type UsageAnchorFact } from "./usage-validation.ts"
import type { SessionEventView as SessionEvent } from "../managed/types.ts"
import { CURRENT_FORMAT_VERSION } from '../events/types.ts'
import { conversationFormatError as fail, conversationSeq, validateConversationEventShape } from "../events/conversation.ts"
import { projectHistory, validateHistoricalReplacement } from './history/replacements.ts'
import { createHistoryIndex } from './history/index.ts'

interface Address { index: number; type: SessionEvent["type"]; step?: number; callId?: string; actionId?: string; attemptId?: string; ambiguous?: boolean }

interface StageOptions { readCurrentEvent?: (index: number) => SessionEvent | undefined }
interface Step { failed: boolean; accepted: boolean; calls: number }
export interface ConversationValidationIndex {
  readonly formatVersion: number
  readonly eventCount: number
  readonly semanticsStartSeq: number | undefined
  stage(events: readonly SessionEvent[], options?: StageOptions): { commit(): void }
  history(throughSeq?: number): ReturnType<typeof projectHistory>
  replacementDependencies(): ReadonlyMap<number, ReadonlySet<number>>
}

/** Derived structural facts only: no prompt, args, native sidecars or outputs. */
export function createConversationValidationIndex(events: readonly SessionEvent[] = [], options: { formatVersion: number } = { formatVersion: CURRENT_FORMAT_VERSION }): ConversationValidationIndex {
  return createConversationIndex(events, undefined, options.formatVersion)
}

/** Internal append-owner port: re-read referenced structural fields, without retaining a second archive. */
export function createConversationIndex(events: readonly SessionEvent[], read?: (index: number) => SessionEvent | undefined, formatVersion = CURRENT_FORMAT_VERSION): ConversationValidationIndex {
  const acceptances = new Map<number, AcceptanceFact>()
  const completions = new Map<number, string>()
  const anchors = new Map<string, UsageAnchorFact>()
  const addresses = new Map<number, Address>()
  const steps = new Map<number, Step>()
  const exchanges = new Set<string>()
  const attempts = new Set<string>()
  const acceptedCalls = new Set<number>()
  const callsById = new Map<string, number | null>()
  const history = createHistoryIndex(formatVersion)
  let count = 0, revision = 0
  let fence: number | undefined, activeStep: number | undefined
  const verify = (seq: number, target: Address, readCurrent = read) => {
    if (!readCurrent || target.index >= count) return
    const actual = readCurrent(target.index)
    if (!actual || actual.seq !== seq || actual.type !== target.type
      || actual.type === "step/start" && (actual.actionId !== target.actionId || actual.attemptId !== target.attemptId)
      || actual.type === "tool/call" && actual.callId !== target.callId) fail("referenced structure was mutated")
  }
  const index: ConversationValidationIndex = {
    get formatVersion() { return formatVersion },
    get eventCount() { return count },
    get semanticsStartSeq() { return fence },
    history: history.history,
    replacementDependencies: history.dependencies,
    stage(suffix, options) {
      const readCurrent = options?.readCurrentEvent ?? read
      const stagedHistory = history.stage(suffix, readCurrent)
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
      for (const [offset, event] of suffix.entries()) {
        validateConversationEventShape(event, formatVersion)
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
          const actual = accepted && (accepted.index < count ? readCurrent?.(accepted.index) : suffix[accepted.index - count])
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
      }
      let committed = false
      return { commit() {
        if (committed) return
        if (epoch !== revision) fail("stale staged suffix")
        for (const [key, value] of newCompletions) completions.set(key, value)
        for (const [key, value] of newAcceptances) acceptances.set(key, value)
        for (const [key, value] of newAnchors) anchors.set(key, value)
        for (const [key, value] of newAddresses) addresses.set(key, value)
        for (const [key, value] of newSteps) steps.set(key, value)
        for (const [key, value] of newCalls) callsById.set(key, value)
        stagedHistory.commit()
        for (const id of newExchanges) exchanges.add(id)
        for (const id of newAttempts) attempts.add(id)
        for (const seq of newAccepted) acceptedCalls.add(seq)
        count += suffix.length; fence = nextFence; activeStep = nextStep; revision++; committed = true
      } }
    },
  }
  index.stage(events).commit()
  return index
}

export function validateConversationHistory(events: readonly SessionEvent[], formatVersion: number): void {
  for (const event of events) validateConversationEventShape(event, formatVersion)
  createConversationValidationIndex(events, { formatVersion })
}
