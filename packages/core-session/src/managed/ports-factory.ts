import type { FactGroupDraft } from "./groups.ts"
import type { FactPorts } from "./ports.ts"

/** Closed constructors: each subsystem receives only its permitted producer
 * port. The admission callback remains private to the document composition. */
export function createFactPorts<Outcome>(admit: (draft: FactGroupDraft) => Promise<Outcome>): FactPorts<Outcome> {
  return {
    inputs: {
      scheduled: (dispatches, admitted) => admit({ kind: 'scheduled-input', dispatches, admitted }),
      admit: admitted => admit({ kind: 'input-admission', admitted }),
      cancel: cancelled => admit({ kind: 'input-cancellation', cancelled }),
      start: (promoted, message) => admit({ kind: 'input-start', promoted, turn: { type: 'turn/start' }, message }),
      claim: (promoted, message) => admit({ kind: 'steer-claim', promoted, message }),
    },
    agent: {
      auditAssistant: assistant => admit({ kind: 'assistant-audit', assistant }),
      feedback: message => admit({ kind: 'plugin-feedback', message }),
      lifecycle: event => admit({ kind: 'lifecycle', event }),
      accept: (assistant, accepted) => admit({ kind: 'exchange-acceptance', assistant, accepted }),
      usage: event => admit({ kind: 'usage', event }),
    },
    tools: {
      call: event => admit({ kind: 'tool', event }),
      result: event => admit({ kind: 'tool', event }),
      dispatch: (callId, eventSeq) => eventSeq ? admit({ kind: 'tool', event: { type: 'tool/dispatch', callId, eventSeq } }) : Promise.reject(new TypeError('Managed dispatch requires a committed call reference')),
    },
    code: {
      record: event => admit({ kind: 'code', event }),
      dispatch: (cellId, callId, eventSeq) => admit({ kind: 'code', event: { type: 'code/dispatch', cellId, callId, eventSeq } }),
    },
    delivery: { record: event => admit({ kind: 'delivery', event }) },
    metadata: { admit: event => admit({ kind: 'metadata', event }), enterPlan: proposal => admit({ kind: 'plan-proposal', mode: { type: 'plan/mode', mode: 'on', proposal }, message: { type: 'user/message', text: proposal } }), importPolicy: modes => admit({ kind: 'policy-import', modes }) },
    compaction: { commit: events => admit({ kind: 'legacy-compaction', events }) },
  }
}
