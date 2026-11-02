import { validateResultFact, validateResultSourceMetadata } from '../results/validate.ts';
import { conversationFormatError as fail } from '../events/conversation.ts';
import { deliveryInputId, deliveryMinimumFormat, isDeliveryEventType, validDeliveryEvent, type DeliveryAdmissionReceipt, type DeliveryReceivedEvent, type DeliveryKey, type DeliverySourceEvent, type ExecDeliverySourceEvent, type ExecTerminalEvent } from '../events/delivery.ts';
import { eligibleExecTerminal } from '../events/exec-delivery.ts';
import { eligibleWorkflowTerminal, workflowTerminalRef } from '../events/workflow-delivery.ts';
import { createWorkflowDeliveryIndex, type WorkflowDeliveryCandidate } from './workflow-delivery.ts';
import { eligibleCodeTerminal, codeTerminalRef } from '../events/code-delivery.ts';
import { createCodeDeliveryIndex, type CodeDeliveryCandidate } from './code-delivery.ts';
import type { GenerationActionEvent } from '../events/generation.ts';
import type { SessionEventView, SessionView } from '../managed/types.ts';
import type { GenerationHistoryScope } from './generation.ts';
import { semanticSourceStructure } from './bootstrap-validation.ts';
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
  sourceNamespace?: string;
  sourceId?: string;
  sourceSeq?: number;
  cellId?: string;
  state?: string;
  sessionId?: string;
  parentCallId?: string;
};
type Dispatch = { callId: string; seq: number };
type InputClass = Readonly<{ admissionSeq: number; kind: 'ordinary' | 'legacy-task' | 'delivery' }>;
const identity = (key: Readonly<DeliveryKey>) => JSON.stringify([key.recipientSessionId, key.sourceNamespace, key.sourceId, key.resultRevision, key.kind]);
const sourceKey = (namespace: string, id: string) => JSON.stringify([namespace, id]);
export interface ExecDeliveryCandidate { source: Readonly<ExecDeliverySourceEvent>; terminal: Readonly<ExecTerminalEvent> }
export interface DeliveryState {
  activeGeneration(): Readonly<{
    generationId: string;
    openedSeq: number;
    originInputSeq: number;
  }> | undefined;
  lastFenceSeq(): number | undefined;
  source(namespace: string, sourceId: string): Readonly<DeliverySourceEvent> | undefined;
  execPending(): readonly ExecDeliveryCandidate[];
  workflowPending(): readonly WorkflowDeliveryCandidate[];
  codePending(): readonly CodeDeliveryCandidate[];
  receipt(key: DeliveryKey): Readonly<{
    event: DeliveryReceivedEvent;
    disposition: DeliveryAdmissionReceipt['disposition'];
  }> | undefined;
  isEligible(inputId: string): boolean;
  pending(): readonly Readonly<{
    inputId: string;
    receiptSeq: number;
  }>[];
}
/** Private owner observation; never a producer/binding port. */
export interface DeliveryReadIndex extends DeliveryState {
  input(inputId: string): InputClass | undefined;
  isBound(inputId: string): boolean;
  inputIdAt(seq: number): string | undefined;
  ownHumanAdmissionSeq(recipientSessionId:string,fromSeq:number,afterSeq:number): number | undefined;
  dispatchForCall(callSeq:number): Readonly<Dispatch> | undefined;
  codeEvidence(sourceSeq:number,terminalSeq:number):Readonly<{source:Readonly<import('../events/code-delivery.ts').CodeDeliverySourceEvent>;terminal:Readonly<import('../events/code-delivery.ts').CodeTerminalEvent>;key:import('../events/code-delivery.ts').CodeDeliveryKey;receipt?:ReturnType<DeliveryState['receipt']>}>|undefined;
  taskEvidence(sourceSeq:number,terminalSeq:number):Readonly<{source:Extract<DeliverySourceEvent,{kind:'subagent'}>;key:import('../events/delivery.ts').SubagentDeliveryKey;receipt?:ReturnType<DeliveryState['receipt']>}>|undefined;
  taskCandidate(namespace:string,id:string):Readonly<{sourceSeq:number;terminalSeq:number}>|undefined;
}
function disposition(receipt: Receipt, active: ReturnType<DeliveryState['activeGeneration']>): DeliveryAdmissionReceipt['disposition'] {
  return receipt.disposition === 'pending' && receipt.generationId !== active?.generationId ? 'suppressed' : receipt.disposition;
}
function admittedPair(receipt: Readonly<DeliveryReceivedEvent>, admitted: SessionEventView | undefined): boolean {
  return admitted?.type === 'agent/input/admitted' && admitted.seq === receipt.seq! + 1 && admitted.inputId === receipt.inputId
    && admitted.delivery === 'steer' && admitted.intent === 'system' && admitted.provenance?.kind === 'child-report'
    && admitted.provenance.authority === 'observation' && admitted.provenance.scope === 'turn' && admitted.provenance.producer === `session.delivery.${receipt.key.kind}`
    && admitted.synthetic?.scope === 'turn' && typeof admitted.synthetic.description === 'string' && admitted.synthetic.description.length > 0
    && admitted.synthetic.display?.kind === 'task' && typeof admitted.synthetic.display.title === 'string' && admitted.synthetic.display.title.length > 0 && typeof admitted.synthetic.display.body === 'string';
}
export function validateDeliveryFrame(events: readonly SessionEventView[], formatVersion: number): void {
  for (const [i, event] of events.entries()) {
    if (isDeliveryEventType(event.type) && (!validDeliveryEvent(event) || formatVersion < deliveryMinimumFormat(event)))
      fail('invalid required delivery fact or format');
    if (event.type === 'agent/delivery-source' && event.kind === 'subagent') {
      const start = events[i - 1];
      if (start?.type !== 'subagent/start' || start.seq !== event.startSeq || start.seq! + 1 !== event.seq || start.taskId !== event.sourceId || start.parentSessionId !== event.recipientSessionId)
        fail('delivery source requires same-frame original start');
    }
    if (event.type === 'agent/delivery-received' && !admittedPair(event, events[i + 1]))
      fail('delivery receipt requires same-frame admission');
    if (event.type === 'agent/input/admitted' && ['session.delivery.subagent', 'session.delivery.exec', 'session.delivery.workflow','session.delivery.code'].includes(event.provenance?.producer ?? '')) {
      const receipt = events[i - 1];
      if (receipt?.type !== 'agent/delivery-received' || !admittedPair(receipt, event) || formatVersion < deliveryMinimumFormat(receipt))
        fail('delivery admission requires same-frame receipt');
    }
  }
}
/** Scalar structural fold. Payload/result bodies remain in the original journal. */
export function createDeliveryIndex(scope: GenerationHistoryScope = {}, profile?: typeof semanticSourceStructure) {
  // Source selection owns excluded payload opacity; journal/writer replay keeps
  // the strict validator. The fold still reads the same terminal scalar proof.
  const validateTerminal = profile === semanticSourceStructure ? validateResultSourceMetadata : validateResultFact;
  const refs = new Map<number, Ref>(), sources = new Map<string, DeliverySourceEvent>(), receipts = new Map<string, Receipt>(), inputs = new Map<string, string>();
  const execTerminals = new Map<number, ExecTerminalEvent>(), parentHandoffs = new Set<number>(), execPending = new Map<number, ExecDeliveryCandidate>();
  const workflows = createWorkflowDeliveryIndex();
  const codes = createCodeDeliveryIndex(), codeCells=new Set<string>(), codeCalls=new Set<number>();
  const dispatches = new Map<number, Dispatch>(), admissions = new Map<string, InputClass>(), opens = new Set<string>(), fences = new Set<string>();
  const humanAdmissions:number[]=[];
  let active: ReturnType<DeliveryState['activeGeneration']>, fence: number | undefined, owner = scope.sessionId, turn: number | undefined, turnAction: string | undefined;
  const state = (): DeliveryState => ({
    activeGeneration: () => active, lastFenceSeq: () => fence, source: (ns, id) => {
      const value = sources.get(sourceKey(ns, id));
      return value && Object.freeze({ ...value });
    }, execPending: () => [...execPending.values()].map(candidate => structuredClone(candidate)), workflowPending: workflows.pending, codePending:codes.pending, receipt: key => {
      const value = receipts.get(identity(key));
      return value && Object.freeze({ event: Object.freeze({ ...value.event, key: Object.freeze({ ...value.event.key }) }), disposition: disposition(value, active) });
    },
    isEligible: id => {
      const r = receipts.get(inputs.get(id) ?? '');
      return !!r && r.disposition === 'pending' && r.generationId === active?.generationId;
    },
    pending: () => [...receipts.values()].filter(r => r.disposition === 'pending' && r.generationId === active?.generationId).map(r => ({ inputId: r.event.inputId, receiptSeq: r.event.seq! }))
  });
  return {
    read: state,
    readIndex: (): DeliveryReadIndex => Object.freeze({ ...state(), input: (id: string) => admissions.get(id), isBound: (id: string) => inputs.has(id), inputIdAt: (seq: number) => refs.get(seq)?.inputId,
      ownHumanAdmissionSeq(recipientSessionId:string,fromSeq:number,afterSeq:number){for(let i=humanAdmissions.length-1;i>=0;i--){const seq=humanAdmissions[i]!;if(seq<fromSeq||seq<=afterSeq)break;const ref=refs.get(seq)!;if(ref.originSessionId===undefined||ref.originSessionId===recipientSessionId)return seq}return undefined},
      dispatchForCall(callSeq:number){const found=dispatches.get(callSeq);return found&&Object.freeze({...found})},
      taskCandidate(namespace:string,id:string){const binding=sources.get(sourceKey(namespace,id));if(!binding||binding.kind!=='subagent'||binding.seq===undefined)return undefined;let seq:number|undefined;for(const [ordinal,ref] of refs)if(ref.type==='subagent/end'&&ref.taskId===id&&ref.qualified&&ordinal>binding.seq&&(seq===undefined||ordinal>seq))seq=ordinal;return seq===undefined?undefined:{sourceSeq:binding.seq,terminalSeq:seq}},
      taskEvidence(sourceSeq:number,terminalSeq:number){
        const terminal=refs.get(terminalSeq),binding=[...sources.values()].find(value=>value.seq===sourceSeq)
        if(!binding||terminal?.type!=='subagent/end'||terminal.taskId!==binding.sourceId||!terminal.qualified||!terminal.resultRevision||terminalSeq<=sourceSeq)return undefined
        if(!binding||binding.kind!=='subagent'||binding.seq!==sourceSeq||owner!==undefined&&binding.recipientSessionId!==owner)return undefined
        const key={kind:'subagent' as const,recipientSessionId:binding.recipientSessionId,sourceNamespace:binding.sourceNamespace,sourceId:binding.sourceId,resultRevision:terminal.resultRevision},receipt=state().receipt(key)
        if(receipt&&(receipt.event.sourceSeq!==sourceSeq||receipt.event.terminalSeq!==terminalSeq))return undefined
        return {source:structuredClone(binding),key,...receipt?{receipt}:{}}
      },
      codeEvidence(sourceSeq:number,terminalSeq:number){
        const r=refs.get(sourceSeq);if(r?.type!=='agent/delivery-source'||r.sourceNamespace!=='code'||!r.sourceId)return undefined
        const binding=sources.get(sourceKey('code',r.sourceId)),terminal=codes.terminal(sourceSeq)
        if(!binding||binding.kind!=='code'||binding.seq!==sourceSeq||!terminal||terminal.seq!==terminalSeq||terminal.sourceSeq!==sourceSeq||terminal.cellId!==binding.cellId||owner!==undefined&&binding.recipientSessionId!==owner)return undefined
        const ref=codeTerminalRef(terminal);if(!ref)return undefined
        const key={kind:'code' as const,sourceNamespace:'code' as const,recipientSessionId:binding.recipientSessionId,sourceId:binding.sourceId,resultRevision:ref.revision},receipt=state().receipt(key)
        if(receipt&&(receipt.event.sourceSeq!==sourceSeq||receipt.event.terminalSeq!==terminalSeq))return undefined
        return {source:structuredClone(binding),terminal,key,...receipt?{receipt}:{}}
      },
    }),
    stage() {
      const stagedRefs = new Map<number, Ref>(), stagedSources = new Map<string, DeliverySourceEvent>(), stagedInputs = new Map<string, string>(), stagedReceipts = new Map<string, Receipt>();
      const stagedExecTerminals = new Map<number, ExecTerminalEvent>(), stagedHandoffs = new Set<number>(), stagedExecPending = new Map<number, ExecDeliveryCandidate | undefined>();
      const stagedDispatches = new Map<number, Dispatch>(), stagedAdmissions = new Map<string, InputClass>(), stagedGenerations = new Set<string>(), stagedFences = new Set<string>();
      const stagedCodeCells=new Set<string>(), stagedCodeCalls=new Set<number>();
      let stagedActive = active, stagedFence = fence, stagedOwner = owner, stagedTurn = turn, stagedTurnAction = turnAction, previous: SessionEventView | undefined, awaiting: DeliveryReceivedEvent | undefined;
      const reference = (seq: number) => stagedRefs.get(seq) ?? refs.get(seq);
      const source = (key: string) => stagedSources.get(key) ?? sources.get(key);
      const receipt = (key: string) => stagedReceipts.get(key) ?? receipts.get(key);
      const dispatch = (seq: number) => stagedDispatches.get(seq) ?? dispatches.get(seq);
      const execSource = (seq: number): ExecDeliverySourceEvent | undefined => {
        const ref = reference(seq);
        if (ref?.type !== 'agent/delivery-source' || !ref.sourceNamespace || !ref.sourceId) return;
        const binding = source(sourceKey(ref.sourceNamespace, ref.sourceId));
        return binding?.kind === 'exec' && binding.seq === seq ? binding : undefined;
      };
      const execTerminal = (seq: number) => stagedExecTerminals.get(seq) ?? execTerminals.get(seq);
      const workflow = workflows.stage({
        source(seq) {
          const ref = reference(seq)
          if (ref?.type !== 'agent/delivery-source' || ref.sourceNamespace !== 'workflow' || !ref.sourceId) return
          const binding = source(sourceKey('workflow', ref.sourceId))
          return binding?.kind === 'workflow' && binding.seq === seq ? binding : undefined
        }, generation: () => stagedActive?.generationId, received: key => !!receipt(identity(key)),
      });
      const code=codes.stage({source(seq){const ref=reference(seq);if(ref?.type!=='agent/delivery-source'||ref.sourceNamespace!=='code'||!ref.sourceId)return;const binding=source(sourceKey('code',ref.sourceId));return binding?.kind==='code'&&binding.seq===seq?binding:undefined},generation:()=>stagedActive?.generationId,received:key=>!!receipt(identity(key)),member(seq,binding,type,status){const ref=reference(seq),state=status==='replanned'?'failed':status==='policy-refused'?'terminated':status;return ref?.type===type&&ref.cellId===binding.cellId&&ref.sessionId===binding.recipientSessionId&&(type==='code/store'||ref.state===state&&ref.parentCallId===reference(binding.callSeq)?.callId)}});
      const parentRoute = (binding: ExecDeliverySourceEvent) => binding.delivery === 'parent' || stagedHandoffs.has(binding.seq!) || parentHandoffs.has(binding.seq!);
      const refreshExecCandidate = (binding: ExecDeliverySourceEvent) => {
        const terminal = execTerminal(binding.seq!);
        const key: DeliveryKey | undefined = terminal && 'dependency' in terminal && terminal.dependency.retention.kind === 'artifact'
          ? { kind: 'exec', recipientSessionId: binding.recipientSessionId, sourceNamespace: 'exec', sourceId: binding.sourceId, resultRevision: terminal.dependency.retention.ref.revision } : undefined;
        stagedExecPending.set(binding.seq!, terminal && key && parentRoute(binding) && eligibleExecTerminal(terminal)
          && binding.generationId === stagedActive?.generationId && !receipt(identity(key)) ? { source: binding, terminal } : undefined);
      };
      const recipient = (id: string) => {
        if (stagedOwner !== undefined && stagedOwner !== id)
          fail('foreign delivery recipient');
        stagedOwner = id;
      };
      const receiptFor = (id: string) => receipt(stagedInputs.get(id) ?? inputs.get(id) ?? '');
      const writableReceipt = (value: Receipt): Receipt => {
        const key = identity(value.event.key);
        let changed = stagedReceipts.get(key);
        if (!changed) { changed = { ...value }; stagedReceipts.set(key, changed); }
        return changed;
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
          const inputId = reference(open.origin.seq)?.inputId;
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
        const changed = writableReceipt(r);
        changed.origin = Object.freeze({ receiptSeq: r.event.seq!, admissionSeq: r.admissionSeq, inputId: r.event.inputId, actionId: open.actionId, openedSeq: open.seq!, ...(r.inputStart ? { inputStart: r.inputStart } : {}) });
        return changed.origin;
      };
      return {
        lookupActionOrigin, advance(event: SessionEventView) {
          if (event.type === 'subagent/end')
            validateTerminal(event, 13);
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
                if (stagedFences.has(event.fenceId) || fences.has(event.fenceId))
                  fail('duplicate delivery fence');
                stagedFences.add(event.fenceId);
                stagedFence = event.seq;
                stagedActive = undefined;
              }
              else {
                const origin = reference(event.originInputSeq);
                if (stagedActive || stagedGenerations.has(event.generationId) || opens.has(event.generationId) || !origin?.human || origin.originSessionId !== undefined && origin.originSessionId !== event.recipientSessionId || event.originInputSeq >= event.seq! || event.originInputSeq < (scope.seedLength ?? 0) || stagedFence !== undefined && event.originInputSeq <= stagedFence)
                  fail('ineligible own human delivery origin');
                stagedGenerations.add(event.generationId);
                stagedActive = Object.freeze({ generationId: event.generationId, openedSeq: event.seq!, originInputSeq: event.originInputSeq });
              }
            }
            if (event.type === 'agent/delivery-source') {
              recipient(event.recipientSessionId);
              const call = reference(event.callSeq), dispatched = dispatch(event.callSeq);
              if (stagedActive?.generationId !== event.generationId || source(sourceKey(event.sourceNamespace, event.sourceId)) || call?.type !== 'tool/call'
                  || event.callSeq < (scope.seedLength ?? 0) || !dispatched || dispatched.callId !== call.callId || dispatched.seq <= event.callSeq || dispatched.seq >= event.seq!)
                fail('uncertified delivery source');
              if (event.kind === 'subagent') {
                const start = reference(event.startSeq);
                if (event.startSeq !== event.seq! - 1 || start?.type !== 'subagent/start' || start.taskId !== event.sourceId || start.parentSessionId !== event.recipientSessionId
                    || call.name !== 'spawn_agent' || dispatched.seq >= event.startSeq) fail('uncertified delivery source');
              } else if (event.kind === 'workflow') { if (call.name !== 'workflow_run') fail('uncertified Workflow delivery source'); }
              else if (event.kind === 'code') {if(call.name!=='code_exec'||codeCells.has(event.cellId)||stagedCodeCells.has(event.cellId)||codeCalls.has(event.callSeq)||stagedCodeCalls.has(event.callSeq))fail('uncertified Code delivery source');stagedCodeCells.add(event.cellId);stagedCodeCalls.add(event.callSeq)}
              else if (!['shell', 'bash', 'pwsh'].includes(call.name ?? '')) fail('uncertified Exec delivery source');
              stagedSources.set(sourceKey(event.sourceNamespace, event.sourceId), event);
            }
            if (event.type === 'agent/delivery-handoff') {
              if (event.kind === 'workflow') workflow.handoff(event.sourceSeq, event.seq!);
              else if(event.kind==='code')code.handoff(event.sourceSeq,event.seq!);
              else {
              const binding = execSource(event.sourceSeq);
              if (!binding || event.sourceSeq >= event.seq! || binding.generationId !== stagedActive?.generationId || parentRoute(binding)) fail('invalid Exec parent handoff');
              stagedHandoffs.add(event.sourceSeq); refreshExecCandidate(binding);
              }
            }
            if (event.type === 'workflow/end') workflow.end(event);
            if (event.type === 'code/end') code.end(event);
            if (event.type === 'exec/end') {
              const binding = execSource(event.sourceSeq);
              if (!binding || event.sourceSeq >= event.seq! || binding.sourceId !== event.instanceId || execTerminal(event.sourceSeq)) fail('invalid or duplicate Exec terminal');
              stagedExecTerminals.set(event.sourceSeq, event); refreshExecCandidate(binding);
            }
            if (event.type === 'agent/delivery-received') {
              recipient(event.key.recipientSessionId);
              const binding = source(sourceKey(event.key.sourceNamespace, event.key.sourceId)), terminal = reference(event.terminalSeq);
              if (!binding || binding.kind !== event.key.kind || binding.seq !== event.sourceSeq || binding.recipientSessionId !== event.key.recipientSessionId || binding.generationId !== stagedActive?.generationId || event.terminalSeq <= event.sourceSeq || event.terminalSeq >= event.seq! || terminal?.resultRevision !== event.key.resultRevision || !terminal.qualified || receipt(identity(event.key)) || stagedInputs.has(event.inputId) || inputs.has(event.inputId) || event.inputId !== deliveryInputId(event.key))
                fail('unqualified or duplicate delivery receipt');
              if (binding.kind === 'subagent' ? terminal.type !== 'subagent/end' || terminal.taskId !== event.key.sourceId
                  : binding.kind === 'workflow' ? terminal.type !== 'workflow/end' || terminal.sourceSeq !== binding.seq || terminal.sourceId !== binding.sourceId || !workflow.parent(binding)
                  : binding.kind === 'code' ? terminal.type !== 'code/end' || terminal.sourceSeq !== binding.seq || terminal.sourceId !== binding.sourceId || !code.parent(binding)
                  : terminal.type !== 'exec/end' || terminal.sourceSeq !== binding.seq || terminal.sourceId !== binding.sourceId || !parentRoute(binding)) fail('unqualified delivery terminal kind');
              stagedReceipts.set(identity(event.key), { event, disposition: 'pending', admissionSeq: event.seq! + 1, generationId: binding.generationId });
              stagedInputs.set(event.inputId, identity(event.key));
              if (binding.kind === 'exec') stagedExecPending.set(binding.seq!, undefined);
              if (binding.kind === 'workflow') workflow.received(binding.seq!);
              if (binding.kind === 'code') code.received(binding.seq!);
              awaiting = event;
            }
          }
          if (event.type === 'agent/input/admitted' && receiptFor(event.inputId) && receiptFor(event.inputId)!.admissionSeq !== event.seq) fail('delivery input identity cannot be reused');
          if (event.type === 'rewind/point') {
            stagedFence = event.seq;
            stagedActive = undefined;
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
              const current = disposition(r, stagedActive);
              if (current !== 'pending' && !(event.type === 'agent/input/cancelled' && current === 'suppressed'))
                fail('ineligible delivery consumption');
              const changed = writableReceipt(r);
              changed.disposition = event.type === 'agent/input/promoted' ? 'claimed' : 'cancelled';
              if (event.type === 'agent/input/promoted')
                changed.promotionSeq = event.seq;
            }
          }
          if (event.type === 'user/message' && event.input) {
            const r = receiptFor(event.input.inputId);
            if (r && r.promotionSeq !== undefined && previous?.type === 'turn/start' && previous.seq === r.promotionSeq + 1 && event.seq === previous.seq! + 1)
              writableReceipt(r).inputStart = Object.freeze({ promotionSeq: r.promotionSeq, turnStartSeq: previous.seq!, rawMessageSeq: event.seq! });
          }
          if (event.type === 'context/action' && event.op === 'open') {
            lookupActionOrigin(event);
            if (event.purpose === 'main' && stagedTurn !== undefined)
              stagedTurnAction = event.actionId;
          }
          if (event.seq !== undefined && event.type === 'tool/dispatch' && event.eventSeq !== undefined) {
            const call = reference(event.eventSeq);
            // Keep the earliest actual matching dispatch, never a permission bit
            // or a later mismatched dispatch overwriting the original proof.
            const prior = dispatch(event.eventSeq);
            if (call?.type === 'tool/call' && call.callId === event.callId && event.eventSeq < event.seq && (!prior || event.seq < prior.seq))
              stagedDispatches.set(event.eventSeq, { callId: event.callId, seq: event.seq });
          }
          if (event.type === 'agent/input/admitted' && event.seq !== undefined)
            stagedAdmissions.set(event.inputId, Object.freeze({ admissionSeq: event.seq, kind: ['session.delivery.subagent', 'session.delivery.exec', 'session.delivery.workflow','session.delivery.code'].includes(event.provenance?.producer ?? '') ? 'delivery' : event.provenance?.producer === 'session.notification' && event.synthetic?.display?.kind === 'task' ? 'legacy-task' : 'ordinary' }));
          if (event.seq !== undefined && (['agent/input/admitted', 'tool/call', 'subagent/start', 'subagent/end', 'exec/end', 'workflow/end','code/end','code/cell','code/store'].includes(event.type) || event.type === 'agent/delivery-source' && event.kind !== 'subagent' || event.type === 'user/message' && event.input)) {
            const ref: Ref = { type: event.type };
            if (event.type === 'agent/input/admitted')
              Object.assign(ref, { inputId: event.inputId, human: event.intent === 'user' && !event.synthetic && event.provenance?.kind === 'human' && event.provenance.authority === 'request', originSessionId: event.provenance?.originSessionId });
            if (event.type === 'user/message')
              ref.inputId = event.input?.inputId;
            if (event.type === 'tool/call')
              Object.assign(ref, { name: event.name, callId: event.callId });
            if (event.type === 'subagent/start')
              Object.assign(ref, { taskId: event.taskId, parentSessionId: event.parentSessionId });
            if (event.type === 'subagent/end')
              Object.assign(ref, { taskId: event.taskId, resultRevision: event.resultRevision, qualified: !!event.envelope && event.envelope.retention.kind !== 'unavailable' && event.envelope.execution.dispatch === 'dispatched' && (event.outcome === 'completed' && event.envelope.execution.outcome === 'succeeded' || event.outcome === 'error' && event.envelope.execution.outcome === 'failed') });
            if (event.type === 'agent/delivery-source') Object.assign(ref, { sourceNamespace: event.sourceNamespace, sourceId: event.sourceId });
            if (event.type === 'exec/end') Object.assign(ref, { sourceSeq: event.sourceSeq, sourceId: event.instanceId, qualified: eligibleExecTerminal(event),
              resultRevision: 'dependency' in event && event.dependency.retention.kind === 'artifact' ? event.dependency.retention.ref.revision : undefined });
            if (event.type === 'workflow/end') Object.assign(ref, { sourceSeq: event.sourceSeq, sourceId: event.invocationId, qualified: eligibleWorkflowTerminal(event), resultRevision: workflowTerminalRef(event)?.revision });
            if (event.type === 'code/end') Object.assign(ref,{sourceSeq:event.sourceSeq,sourceId:reference(event.sourceSeq)?.sourceId,qualified:eligibleCodeTerminal(event),resultRevision:codeTerminalRef(event)?.revision});
            if(event.type==='code/cell')Object.assign(ref,{cellId:event.cellId,state:event.state,sessionId:event.sessionId,parentCallId:event.parentCallId});
            if(event.type==='code/store')Object.assign(ref,{cellId:event.cellId,sessionId:event.sessionId});
            stagedRefs.set(event.seq, ref);
          }
          previous = event;
        }, validate() {
          if (awaiting)
            fail('unpaired delivery receipt');
        }, commit() {
          if (awaiting)
            fail('unpaired delivery receipt');
          for (const [key, value] of stagedRefs) {refs.set(key, value);if(value.type==='agent/input/admitted'&&value.human)humanAdmissions.push(key)}
          for (const [key, value] of stagedSources) sources.set(key, value);
          for(const cell of stagedCodeCells)codeCells.add(cell);
          for(const call of stagedCodeCalls)codeCalls.add(call);
          for (const [key, value] of stagedReceipts) receipts.set(key, value);
          for (const [key, value] of stagedInputs) inputs.set(key, value);
          for (const [key, value] of stagedDispatches) dispatches.set(key, value);
          for (const [key, value] of stagedAdmissions) admissions.set(key, value);
          for (const [key, value] of stagedExecTerminals) execTerminals.set(key, value);
          for (const value of stagedHandoffs) parentHandoffs.add(value);
          const generationChanged = active?.generationId !== stagedActive?.generationId;
          workflow.commit(generationChanged);
          code.commit(generationChanged);
          if (generationChanged) execPending.clear();
          for (const [key, value] of stagedExecPending) {
            if (value && value.source.generationId === stagedActive?.generationId) execPending.set(key, value);
            else execPending.delete(key);
          }
          active = stagedActive;
          fence = stagedFence;
          owner = stagedOwner;
          for (const id of stagedGenerations) opens.add(id);
          for (const id of stagedFences) fences.add(id);
          turn = stagedTurn;
          turnAction = stagedTurnAction;
        }
      };
    }
  };
}
function replayDeliveryIndex(view: SessionView) {
  validateDeliveryFrame(view.events, view.formatVersion);
  const index = createDeliveryIndex(view.header ?? {}), staged = index.stage();
  for (const event of view.events)
    staged.advance(event);
  staged.commit();
  return index;
}
export function readDeliveries(view: SessionView): DeliveryState { return replayDeliveryIndex(view).read(); }
/** Unbound/mutable observations replay once; no independently cached authority. */
export function readDeliveryIndex(view: SessionView): DeliveryReadIndex { return replayDeliveryIndex(view).readIndex(); }
