import { agentFacts, committedFactSeqs } from './facts.ts'
import type { LLMStreamEvent } from "@i-harness/llm-seam"
import type { AgentDeps, TurnLifecycle } from "./types.ts"
import { createModelStep } from "./model-step.ts"
import { FactRecoveryRequiredError } from '@i-harness/core-session'
export type { ModelStep } from "./model-step.ts"

export function createModelLoop(deps: Pick<AgentDeps, "session" | "telemetry" | 'facts' | 'sourceFacts'>) {
  let callSeq = 0
  const usedCallIds = new Set(deps.session.events.filter((event) => event.type === "tool/call").map((event) => event.callId))
  const reasoning: string[] = []
  async function recordCall(ev: Extract<LLMStreamEvent, { type: "tool_call" }>) {
    callSeq += 1
    let callId = ev.call.id
    if (callId) {
      if (usedCallIds.has(callId)) throw new Error(`duplicate provider tool call id: ${callId}`)
    } else {
      callId = `call_${callSeq}`
      while (usedCallIds.has(callId)) callId = `call_${++callSeq}`
    }
    usedCallIds.add(callId)
    // Capture the durable tool/call sequence before append assigns it.
    const [eventSeq] = committedFactSeqs(await agentFacts(deps).tools.call({ type: "tool/call", callId, name: ev.call.name, args: ev.call.args }))
    const call = eventSeq === undefined ? undefined : deps.session.events[eventSeq]
    if (!call || call.type !== 'tool/call' || call.callId !== callId || call.seq !== eventSeq) throw new FactRecoveryRequiredError()
    return { callId: call.callId, name: call.name, args: call.args, eventSeq }
  }
  return {
    start: (lifecycle: TurnLifecycle, startSeq: number, abort: AbortSignal | undefined, getSteps: () => number) =>
      createModelStep(deps, reasoning, recordCall, lifecycle, startSeq, abort, getSteps),
    reasoning,
  }
}
