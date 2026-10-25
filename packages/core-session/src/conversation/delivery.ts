import { validateResultFact } from '../results/validate.ts';
import { conversationFormatError as fail } from '../events/conversation.ts';
import { deliveryInputId, isDeliveryEventType, validDeliveryEvent, type DeliveryAdmissionReceipt, type DeliveryReceivedEvent, type SubagentDeliveryKey, type SubagentDeliverySourceEvent } from '../events/delivery.ts';
import type { GenerationActionEvent } from '../events/generation.ts';
import type { SessionEventView, SessionView } from '../managed/types.ts';
import type { GenerationHistoryScope } from './generation.ts';
export type MainActionOpen = Extract<GenerationActionEvent, {
  op: 'open';
}>;
export interface DeliveryActionOrigin {
  receiptSeq: number;
  admissionSeq: number;
  inputId: string;
  actionId: string;
  openedSeq: number;
  inputStart?: Readonly<{
    promotionSeq: number;
    turnStartSeq: number;
    rawMessageSeq: number;
  }>;
}
export interface DeliveryOriginLookup {
  lookupActionOrigin(open: Readonly<MainActionOpen>): Readonly<DeliveryActionOrigin> | undefined;
}
type Receipt = {
  event: DeliveryReceivedEvent;
  disposition: DeliveryAdmissionReceipt['disposition'];
  admissionSeq: number;
  generationId: string;
  origin?: DeliveryActionOrigin;
  promotionSeq?: number;
  inputStart?: DeliveryActionOrigin['inputStart'];
};
type Ref = {
  type: string;
  taskId?: string;
  parentSessionId?: string;
  name?: string;
  callId?: string;
  eventSeq?: number;
  inputId?: string;
  human?: boolean;
  originSessionId?: string;
  resultRevision?: string;
  qualified?: boolean;
};
const identity = (key: Readonly<SubagentDeliveryKey>) => JSON.stringify([key.recipientSessionId, key.sourceNamespace, key.sourceId, key.resultRevision, key.kind]);
const sourceKey = (namespace: string, id: string) => JSON.stringify([namespace, id]);
export interface DeliveryState {
  activeGeneration(): Readonly<{
    generationId: string;
    openedSeq: number;
    originInputSeq: number;
  }> | undefined;
  lastFenceSeq(): number | undefined;
  source(namespace: string, sourceId: string): Readonly<SubagentDeliverySourceEvent> | undefined;
  receipt(key: SubagentDeliveryKey): Readonly<{
    event: DeliveryReceivedEvent;
    disposition: DeliveryAdmissionReceipt['disposition'];
  }> | undefined;
  isEligible(inputId: string): boolean;
  pending(): readonly Readonly<{
    inputId: string;
    receiptSeq: number;
  }>[];
}
function admittedPair(receipt: Readonly<DeliveryReceivedEvent>, admitted: SessionEventView | undefined): boolean {
  return admitted?.type === 'agent/input/admitted' && admitted.seq === receipt.seq! + 1 && admitted.inputId === receipt.inputId
    && admitted.delivery === 'steer' && admitted.intent === 'system' && admitted.provenance?.kind === 'child-report'
    && admitted.provenance.authority === 'observation' && admitted.provenance.scope === 'turn' && admitted.provenance.producer === 'session.delivery.subagent'
    && admitted.synthetic?.scope === 'turn' && typeof admitted.synthetic.description === 'string' && admitted.synthetic.description.length > 0
    && admitted.synthetic.display?.kind === 'task' && typeof admitted.synthetic.display.title === 'string' && admitted.synthetic.display.title.length > 0 && typeof admitted.synthetic.display.body === 'string';
}
export function validateDeliveryFrame(events: readonly SessionEventView[], formatVersion: number): void {
  for (const [i, event] of events.entries()) {
    if (isDeliveryEventType(event.type) && (formatVersion < 13 || !validDeliveryEvent(event)))
      fail('invalid required delivery fact or format');
    if (event.type === 'agent/delivery-source') {
      const start = events[i - 1];
      if (start?.type !== 'subagent/start' || start.seq !== event.startSeq || start.seq! + 1 !== event.seq || start.taskId !== event.sourceId || start.parentSessionId !== event.recipientSessionId)
        fail('delivery source requires same-frame original start');
    }
    if (event.type === 'agent/delivery-received' && !admittedPair(event, events[i + 1]))
      fail('delivery receipt requires same-frame admission');
    if (event.type === 'agent/input/admitted' && event.provenance?.producer === 'session.delivery.subagent') {
      const receipt = events[i - 1];
      if (receipt?.type !== 'agent/delivery-received' || !admittedPair(receipt, event) || formatVersion < 13)
        fail('delivery admission requires same-frame receipt');
    }
  }
}
/** Scalar structural fold. Payload/result bodies remain in the original journal. */
export function createDeliveryIndex(scope: GenerationHistoryScope = {}) {
  let refs = new Map<number, Ref>(), sources = new Map<string, SubagentDeliverySourceEvent>(), receipts = new Map<string, Receipt>(), inputs = new Map<string, string>();
  let active: ReturnType<DeliveryState['activeGeneration']>, fence: number | undefined, owner = scope.sessionId, opens = new Set<string>(), fences = new Set<string>(), turn: number | undefined, turnAction: string | undefined;
  const state = (): DeliveryState => ({
    activeGeneration: () => active, lastFenceSeq: () => fence, source: (ns, id) => {
      const value = sources.get(sourceKey(ns, id));
      return value && Object.freeze({ ...value });
    }, receipt: key => {
      const value = receipts.get(identity(key));
      return value && Object.freeze({ event: Object.freeze({ ...value.event, key: Object.freeze({ ...value.event.key }) }), disposition: value.disposition });
    },
    isEligible: id => {
      const r = receipts.get(inputs.get(id) ?? '');
      return !!r && r.disposition === 'pending' && r.generationId === active?.generationId;
    },
    pending: () => [...receipts.values()].filter(r => r.disposition === 'pending' && r.generationId === active?.generationId).map(r => ({ inputId: r.event.inputId, receiptSeq: r.event.seq! }))
  });
  return {
    read: state, stage() {
      const stagedRefs = new Map(refs), stagedSources = new Map(sources), stagedInputs = new Map(inputs), stagedReceipts = new Map([...receipts].map(([k, r]) => [k, { ...r }]));
      const stagedGenerations = new Set(opens), stagedFences = new Set(fences);
      let stagedActive = active, stagedFence = fence, stagedOwner = owner, stagedTurn = turn, stagedTurnAction = turnAction, previous: SessionEventView | undefined, awaiting: DeliveryReceivedEvent | undefined;
      const recipient = (id: string) => {
        if (stagedOwner !== undefined && stagedOwner !== id)
          fail('foreign delivery recipient');
        stagedOwner = id;
      };
      const receiptFor = (id: string) => stagedReceipts.get(stagedInputs.get(id) ?? '');
      const suppress = () => {
        stagedActive = undefined;
        for (const r of stagedReceipts.values())
          if (r.disposition === 'pending')
            r.disposition = 'suppressed';
      };
      const lookupActionOrigin = (open: Readonly<MainActionOpen>): Readonly<DeliveryActionOrigin> | undefined => {
        if (open.purpose !== 'main')
          return;
        let r: Receipt | undefined;
        if (open.origin.kind === 'observation-input') {
          r = receiptFor(open.origin.inputId);
          if (r?.admissionSeq !== open.origin.seq)
            return;
        }
        else if (open.origin.kind === 'input') {
          const inputId = stagedRefs.get(open.origin.seq)?.inputId;
          r = inputId ? receiptFor(inputId) : undefined;
          if (r && r.inputStart?.rawMessageSeq !== open.origin.seq)
            fail('delivery steer or nonraw input cannot open an action');
        }
        if (!r)
          return;
        if (r.origin) {
          if (r.origin.actionId === open.actionId && r.origin.openedSeq === open.seq && open.ownerSessionId === r.event.key.recipientSessionId)
            return r.origin;
          fail('delivery receipt already owns its original action');
        }
        if (open.origin.kind === 'input' && stagedTurnAction !== undefined)
          fail('delivery turn already owns a main action');
        if (open.ownerSessionId !== r.event.key.recipientSessionId || r.generationId !== stagedActive?.generationId || stagedFence !== undefined && open.seq! <= stagedFence)
          fail('fenced delivery action origin');
        if (open.origin.kind === 'observation-input' ? r.disposition !== 'pending' : !r.inputStart || r.disposition !== 'claimed' || r.inputStart.turnStartSeq !== stagedTurn)
          fail('consumed delivery cannot open a new action');
        r.origin = Object.freeze({ receiptSeq: r.event.seq!, admissionSeq: r.admissionSeq, inputId: r.event.inputId, actionId: open.actionId, openedSeq: open.seq!, ...(r.inputStart ? { inputStart: r.inputStart } : {}) });
        return r.origin;
      };
      return {
        lookupActionOrigin, advance(event: SessionEventView) {
          if (event.type === 'subagent/end')
            validateResultFact(event, 13);
          if (awaiting) {
            if (!admittedPair(awaiting, event))
              fail('unpaired delivery admission');
            awaiting = undefined;
          }
          if (isDeliveryEventType(event.type)) {
            if (!validDeliveryEvent(event) || event.seq === undefined || event.seq < (scope.seedLength ?? 0))
              fail('invalid or inherited delivery authority');
            if (event.type === 'agent/delivery-generation') {
              recipient(event.recipientSessionId);
              if (event.op === 'close') {
                if (stagedFences.has(event.fenceId))
                  fail('duplicate delivery fence');
                stagedFences.add(event.fenceId);
                stagedFence = event.seq;
                suppress();
              }
              else {
                const origin = stagedRefs.get(event.originInputSeq);
                if (stagedActive || stagedGenerations.has(event.generationId) || !origin?.human || origin.originSessionId !== undefined && origin.originSessionId !== event.recipientSessionId || event.originInputSeq >= event.seq! || event.originInputSeq < (scope.seedLength ?? 0) || stagedFence !== undefined && event.originInputSeq <= stagedFence)
                  fail('ineligible own human delivery origin');
                stagedGenerations.add(event.generationId);
                stagedActive = Object.freeze({ generationId: event.generationId, openedSeq: event.seq!, originInputSeq: event.originInputSeq });
              }
            }
            if (event.type === 'agent/delivery-source') {
              recipient(event.recipientSessionId);
              const start = stagedRefs.get(event.startSeq), call = stagedRefs.get(event.callSeq), dispatched = [...stagedRefs.entries()].some(([seq, r]) => seq > event.callSeq && seq < event.startSeq && r.type === 'tool/dispatch' && r.eventSeq === event.callSeq && r.callId === call?.callId);
              if (stagedActive?.generationId !== event.generationId || stagedSources.has(sourceKey(event.sourceNamespace, event.sourceId)) || event.startSeq !== event.seq! - 1 || start?.type !== 'subagent/start' || start.taskId !== event.sourceId || start.parentSessionId !== event.recipientSessionId || call?.type !== 'tool/call' || call.name !== 'spawn_agent' || event.callSeq < (scope.seedLength ?? 0) || !dispatched)
                fail('uncertified delivery source');
              stagedSources.set(sourceKey(event.sourceNamespace, event.sourceId), event);
            }
            if (event.type === 'agent/delivery-received') {
              recipient(event.key.recipientSessionId);
              const binding = stagedSources.get(sourceKey(event.key.sourceNamespace, event.key.sourceId)), terminal = stagedRefs.get(event.terminalSeq);
              if (!binding || binding.seq !== event.sourceSeq || binding.recipientSessionId !== event.key.recipientSessionId || binding.generationId !== stagedActive?.generationId || event.terminalSeq <= event.sourceSeq || event.terminalSeq >= event.seq! || terminal?.type !== 'subagent/end' || terminal.taskId !== event.key.sourceId || terminal.resultRevision !== event.key.resultRevision || !terminal.qualified || stagedReceipts.has(identity(event.key)) || stagedInputs.has(event.inputId) || event.inputId !== deliveryInputId(event.key))
                fail('unqualified or duplicate delivery receipt');
              stagedReceipts.set(identity(event.key), { event, disposition: 'pending', admissionSeq: event.seq! + 1, generationId: binding.generationId });
              stagedInputs.set(event.inputId, identity(event.key));
              awaiting = event;
            }
          }
          if (event.type === 'agent/input/admitted' && receiptFor(event.inputId) && receiptFor(event.inputId)!.admissionSeq !== event.seq) fail('delivery input identity cannot be reused');
          if (event.type === 'rewind/point') {
            stagedFence = event.seq;
            suppress();
            stagedTurn = undefined;
          }
          if (event.type === 'turn/start') {
            stagedTurn = event.seq;
            stagedTurnAction = previous?.type === 'agent/input/promoted' ? receiptFor(previous.inputId)?.origin?.actionId : undefined;
          }
          if (event.type === 'turn/end') {
            stagedTurn = undefined;
            stagedTurnAction = undefined;
          }
          if (event.type === 'agent/input/promoted' || event.type === 'agent/input/cancelled') {
            const r = receiptFor(event.inputId);
            if (r) {
              if (r.disposition !== 'pending' && !(event.type === 'agent/input/cancelled' && r.disposition === 'suppressed'))
                fail('ineligible delivery consumption');
              r.disposition = event.type === 'agent/input/promoted' ? 'claimed' : 'cancelled';
              if (event.type === 'agent/input/promoted')
                r.promotionSeq = event.seq;
            }
          }
          if (event.type === 'user/message' && event.input) {
            const r = receiptFor(event.input.inputId);
            if (r && r.promotionSeq !== undefined && previous?.type === 'turn/start' && previous.seq === r.promotionSeq + 1 && event.seq === previous.seq! + 1)
              r.inputStart = Object.freeze({ promotionSeq: r.promotionSeq, turnStartSeq: previous.seq!, rawMessageSeq: event.seq! });
          }
          if (event.type === 'context/action' && event.op === 'open') {
            lookupActionOrigin(event);
            if (event.purpose === 'main' && stagedTurn !== undefined)
              stagedTurnAction = event.actionId;
          }
          if (event.seq !== undefined) {
            const ref: Ref = { type: event.type };
            if (event.type === 'agent/input/admitted')
              Object.assign(ref, { inputId: event.inputId, human: event.intent === 'user' && !event.synthetic && event.provenance?.kind === 'human' && event.provenance.authority === 'request', originSessionId: event.provenance?.originSessionId });
            if (event.type === 'user/message')
              ref.inputId = event.input?.inputId;
            if (event.type === 'tool/call')
              Object.assign(ref, { name: event.name, callId: event.callId });
            if (event.type === 'tool/dispatch')
              Object.assign(ref, { eventSeq: event.eventSeq, callId: event.callId });
            if (event.type === 'subagent/start')
              Object.assign(ref, { taskId: event.taskId, parentSessionId: event.parentSessionId });
            if (event.type === 'subagent/end')
              Object.assign(ref, { taskId: event.taskId, resultRevision: event.resultRevision, qualified: !!event.envelope && event.envelope.retention.kind !== 'unavailable' && event.envelope.execution.dispatch === 'dispatched' && (event.outcome === 'completed' && event.envelope.execution.outcome === 'succeeded' || event.outcome === 'error' && event.envelope.execution.outcome === 'failed') });
            stagedRefs.set(event.seq, ref);
          }
          previous = event;
        }, validate() {
          if (awaiting)
            fail('unpaired delivery receipt');
        }, commit() {
          if (awaiting)
            fail('unpaired delivery receipt');
          refs = stagedRefs;
          sources = stagedSources;
          receipts = stagedReceipts;
          inputs = stagedInputs;
          active = stagedActive;
          fence = stagedFence;
          owner = stagedOwner;
          opens = stagedGenerations;
          fences = stagedFences;
          turn = stagedTurn;
          turnAction = stagedTurnAction;
        }
      };
    }
  };
}
export function readDeliveries(view: SessionView): DeliveryState {
  validateDeliveryFrame(view.events, view.formatVersion);
  const index = createDeliveryIndex(view.header ?? {}), staged = index.stage();
  for (const event of view.events)
    staged.advance(event);
  staged.commit();
  return index.read();
}
