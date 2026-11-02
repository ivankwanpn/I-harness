import {createOriginalManagedApprovalAudit,recordOriginalManagedApprovalAction,recordOriginalManagedApprovalSource,type OriginalManagedApprovalAudit} from '../../../core-session/src/managed/approval-audit.ts'
import type {ManagedExecutionDomain} from '@i-harness/core-session/internal/execution'
import { randomUUID } from 'node:crypto'
import { types as utilTypes } from 'node:util'
import { isNondurableSession, readGenerationActions, type CapturedActionFact, type GenerationActionEvent, type GenerationEvent, type GenerationOrigin, type ManagedAction, type ProducerFactOutcome, type FactOutcome, type SessionView } from '@i-harness/core-session'
import { generationError } from '@i-harness/llm-seam'
import type { AgentGenerationLifecycle, AgentGenerationDependencies } from '@i-harness/core-agent'
import { generationClock } from './generation-clock.ts'
import { OwnedGenerationAction } from './generation-action.ts'
import { readOwnedGenerationActions } from '../../../core-session/src/managed/view.ts'
import { retainGenerationClose } from './generation-close-settlement.ts'
import { captureGenerationBudget } from '@i-harness/core-agent'
import { isManagedExecutionOwner, readAcknowledgedExecutionMembers,readManagedSourceGenerations } from '@i-harness/core-session/internal/execution'
import type { ManagedExecutionAttachment } from '../../../session-persistence/src/execution-internal.ts'
import { copyConversationData } from '../../../core-session/src/conversation/render.ts'
const executionGenerations=new WeakMap<object,{execution:ManagedExecutionAttachment;action:ManagedAction<ProducerFactOutcome>;assert():void;methods:Map<string,unknown>;approvalAudit?:(domain:ManagedExecutionDomain)=>OriginalManagedApprovalAudit}>()
/** Original factory association, never enrollment of an incoming callback shape. */
export function assertExecutionGeneration(execution:ManagedExecutionAttachment,generation:object,action?:ManagedAction<ProducerFactOutcome>):void {
  const original=executionGenerations.get(generation)
  if(!original||original.execution!==execution||action!==undefined&&original.action!==action||!isManagedExecutionOwner(execution.identity,execution.owner)||!execution.owner.ownsAction(original.action)||Object.getPrototypeOf(generation)!==OwnedGenerationAction.prototype)throw generationError('GENERATION_UNSUPPORTED')
  for(const [name,method]of original.methods){const descriptor=Object.getOwnPropertyDescriptor(generation,name)??Object.getOwnPropertyDescriptor(OwnedGenerationAction.prototype,name);if(!descriptor||!('value'in descriptor)||descriptor.value!==method)throw generationError('GENERATION_UNSUPPORTED')}
  original.assert()
}

/** Only the original execution generation factory can issue this witness. */
export function captureExecutionApprovalAudit(execution:ManagedExecutionAttachment,domain:ManagedExecutionDomain,generation:object,action:ManagedAction<ProducerFactOutcome>):OriginalManagedApprovalAudit {
 assertExecutionGeneration(execution,generation,action);const original=executionGenerations.get(generation)
 if(!original?.approvalAudit||domain.identity!==execution.identity||domain.owner!==execution.owner)throw generationError('GENERATION_UNSUPPORTED')
 return original.approvalAudit(domain)
}

const sameOrigin = (a: GenerationOrigin, b: GenerationOrigin) => a.kind === b.kind && a.seq === b.seq
  && (a.kind === 'observation-input' ? a.inputId === (b.kind === 'observation-input' ? b.inputId : undefined) : true)
  && ('parentActionId' in a ? a.parentActionId : undefined) === ('parentActionId' in b ? b.parentActionId : undefined)
  && (a.kind === 'delegated-input' ? a.ref === (b.kind === 'delegated-input' ? b.ref : undefined)
    && (a.ref === 'admitted' ? a.inputId : a.messageId) === (b.kind === 'delegated-input' ? b.ref === 'admitted' ? b.inputId : b.messageId : undefined) : true)

/** One lifecycle per real F1 action. Durable facts alone determine allowance;
 * the only private spend information is live proof that a handoff was unsent. */
export function createGenerationLifecycle(view: SessionView, ownerSessionId: string, action: ManagedAction<ProducerFactOutcome>, localTest?: { enabled: boolean; selectedClient(): import('@i-harness/llm-seam').ModelClient | undefined }, dependencies?: Partial<AgentGenerationDependencies>): AgentGenerationLifecycle {
  return generationLifecycle({view},ownerSessionId,action,localTest,dependencies)
}
/** Internal original fold/capture branch; never constructs a Session surrogate. */
export function createExecutionGenerationLifecycle(execution: ManagedExecutionAttachment, ownerSessionId: string, action: ManagedAction<import('@i-harness/core-session').FactOutcome>, localTest?: { enabled: boolean; selectedClient(): import('@i-harness/llm-seam').ModelClient | undefined }, dependencies?: AgentGenerationDependencies): ExecutionGenerationLifecycle {
  if(!isManagedExecutionOwner(execution.identity,execution.owner)||!execution.owner.ownsAction(action))throw generationError('GENERATION_UNSUPPORTED')
  return generationLifecycle({execution},ownerSessionId,action,localTest,dependencies,(drain,beforeDrain)=>{
    const source=action.registerSettlementSource(drain,beforeDrain)
    return {source,read:()=>readManagedSourceGenerations(execution.identity,source)}
  })
}
export interface ExecutionGenerationLifecycle { drain():Promise<void>; open(...args:Parameters<AgentGenerationLifecycle['open']>):Promise<OwnedGenerationAction> }
type NativeSourceRead = {source:import('@i-harness/core-session').SettlementFacts<ProducerFactOutcome>;read():readonly import('@i-harness/core-session').DeepReadonly<import('@i-harness/core-session').GenerationActionState>[]}
function generationLifecycle(domain:{view:SessionView;execution?:never}|{view?:never;execution:ManagedExecutionAttachment}, ownerSessionId:string,action:ManagedAction<ProducerFactOutcome>,localTest?:{enabled:boolean;selectedClient():import('@i-harness/llm-seam').ModelClient|undefined},dependencies?:Partial<AgentGenerationDependencies>,registerNative?:(drain:()=>Promise<void>,beforeDrain?:()=>Promise<void>)=>NativeSourceRead):ExecutionGenerationLifecycle {
  const {view,execution}=domain
  const originalAssertion=execution?Object.getOwnPropertyDescriptor(action,'assertOpen'):undefined
  if(execution&&(!originalAssertion||!('value'in originalAssertion)||typeof originalAssertion.value!=='function'||utilTypes.isProxy(originalAssertion.value)))throw generationError('GENERATION_UNSUPPORTED')
  const assertAction=execution?()=>{
    const current=Object.getOwnPropertyDescriptor(action,'assertOpen')
    if(!current||!('value'in current)||current.value!==originalAssertion!.value||current.enumerable!==originalAssertion!.enumerable||current.writable!==originalAssertion!.writable||current.configurable!==originalAssertion!.configurable)throw generationError('GENERATION_UNSUPPORTED')
    Reflect.apply(originalAssertion!.value,action,[])
  }:()=>action.assertOpen()
  const descriptor = Object.getOwnPropertyDescriptor(action, 'owner'), owner = descriptor && 'value' in descriptor ? descriptor.value as import('@i-harness/core-session').OwnerToken : undefined
  if ((!view || !isNondurableSession(view)) && (!owner || !Object.isFrozen(owner) || descriptor?.writable !== false || descriptor.configurable !== false || owner.sessionId !== ownerSessionId || typeof owner.incarnation !== 'string' || !owner.incarnation)) throw generationError('GENERATION_UNSUPPORTED')
  const incarnation = owner?.incarnation ?? randomUUID(), retained = new Set<CapturedActionFact<ProducerFactOutcome>>()
  const expected=new WeakMap<CapturedActionFact<ProducerFactOutcome>,readonly GenerationEvent[]>()
  const evidenceSource=new WeakMap<CapturedActionFact<ProducerFactOutcome>,object>()
  const audits=new Map<string,OriginalManagedApprovalAudit>()
  const passive=dependencies?.passiveGeneration
  const acknowledge=(capture:CapturedActionFact<ProducerFactOutcome>,outcome:Extract<ProducerFactOutcome,{kind:'committed'|'memory-committed'}>)=>{
    if(!passive)return
    try{
      const originals=expected.get(capture);if(!originals)throw Error('Original generation operation absent')
      const acknowledged=execution ? outcome.kind==='committed' ? readAcknowledgedExecutionMembers(capture,outcome).map(event=>({seq:event.seq!,event})) : [] : outcome.seqs.map(seq=>({seq,event:view!.events[seq]}))
      for(const original of originals){const matches=acknowledged.filter(({event})=>event?.type===original.type&&'actionId' in event&&event.actionId===original.actionId&&'op' in event&&event.op===original.op&&Object.keys(original).every(key=>JSON.stringify((event as unknown as Record<string,unknown>)[key])===JSON.stringify((original as unknown as Record<string,unknown>)[key])))
        if(matches.length!==1)throw Error('Acknowledged generation member unavailable')
        const {seq,event}=matches[0]!;passive.capture({kind:'fact',source:outcome.kind==='committed'?'journal-fact':'memory-committed',event:JSON.parse(JSON.stringify(event)) as GenerationEvent,factSeq:seq})
      }
    }catch{try{passive.unavailable('original-acknowledged-fact-unavailable')}catch{}}
  }
  const remember=(capture:CapturedActionFact<ProducerFactOutcome>,events:readonly GenerationEvent[],sourceOwner?:object)=>{const audited=!!execution&&events.some(event=>'actionId'in event&&audits.has(event.actionId));if(passive||audited)expected.set(capture,JSON.parse(JSON.stringify(events)));if(audited&&sourceOwner)evidenceSource.set(capture,sourceOwner);return capture}
  const running = new Set<Promise<unknown>>()
  const drain = async () => {
    await Promise.allSettled([...running])
    for (const capture of [...retained]) {
      const outcome = await capture.observe()
      if (outcome.kind === 'committed' || outcome.kind === 'memory-committed') { acknowledge(capture,outcome);retained.delete(capture); continue }
      if (outcome.kind === 'unknown' || outcome.kind === 'recovery-required' || outcome.kind === 'conflict') {
        const reconciled = await capture.reconcile()
        if (reconciled.kind === 'committed' || reconciled.kind === 'memory-committed') { acknowledge(capture,reconciled);retained.delete(capture); continue }
      }
      throw generationError('GENERATION_UNCERTAIN')
    }
  }
  const native=registerNative?.(drain,dependencies?.beforeDrain)
  const source = native?.source??action.registerSettlementSource(drain,dependencies?.beforeDrain)
  const scope = { ...view?.header, sessionId: ownerSessionId }
  const read = (): readonly import('@i-harness/core-session').DeepReadonly<import('@i-harness/core-session').GenerationActionState>[] => native ? native.read() : readOwnedGenerationActions(view!, scope) ?? readGenerationActions(view!.events, scope, view!.formatVersion)
  const state = (id: string) => {const original=read().find(value => value.opened.actionId === id);return original&&execution?copyConversationData(original):original}
  const own = <T>(operation: Promise<T>): Promise<T> => {
    running.add(operation)
    void operation.then(() => running.delete(operation), () => running.delete(operation))
    return operation
  }
  const receipt = async (capture: CapturedActionFact<ProducerFactOutcome>) => {
    retained.add(capture)
    const result = await own(capture.admit())
    if (result.kind === 'committed' || result.kind === 'memory-committed') {
      acknowledge(capture,result)
      if(execution&&result.kind==='committed'){const events=expected.get(capture),event=events?.[0],audit=event&&'actionId'in event?audits.get(event.actionId):undefined
        if(audit&&events?.length&&events.every(item=>(item.type==='context/action'&&(item.op==='bind'||item.op==='constrain'))||(item.type==='context/attempt'&&['reserve','rebind','settle'].includes(item.op)))){const sourceOwner=evidenceSource.get(capture);if(sourceOwner)recordOriginalManagedApprovalSource(audit,sourceOwner,capture,result);else recordOriginalManagedApprovalAction(audit,capture,result)}
      }
      retained.delete(capture); return result
    }
    if (result.kind === 'not-issued') {
      retained.delete(capture)
      if (result.code === 'FACT_CANCELLED' || result.code === 'FACT_CLOSED') throw generationError('GENERATION_CLOSED')
      if (result.code === 'FACT_PRECONDITION_STALE') throw generationError('GENERATION_STALE')
    }
    throw generationError('GENERATION_UNCERTAIN')
  }
  const commit = (events: readonly GenerationEvent[], current: () => boolean = () => true) => receipt(remember(action.captureGeneration(events, current),events))
  return { drain: () => source.close(), async open(purpose, origin, options = {}) {
    assertAction()
    if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)) throw generationError('GENERATION_CLOCK_INVALID')
    if (options.maxAttempts !== undefined && (!Number.isSafeInteger(options.maxAttempts) || options.maxAttempts <= 0)) throw new TypeError('Invalid generation attempt limit')
    let openedProof:{capture:CapturedActionFact<ProducerFactOutcome>;outcome:FactOutcome}|undefined
    let persisted = read().find(value => value.opened.purpose === purpose && sameOrigin(value.opened.origin, origin))
    if (!persisted) {
      const {startedAt,expiresAt}=captureGenerationBudget(purpose,options,options.start?.wall??Date.now())
      const event: GenerationActionEvent = { type: 'context/action', version: 1, op: 'open', ownerSessionId, actionId: randomUUID(), purpose, origin, startedAt, expiresAt, trustedAt: startedAt }
      const capture=remember(action.captureGeneration([event],()=>true),[event]),outcome=await receipt(capture);if(outcome.kind==='committed')openedProof={capture,outcome}
      persisted = state(event.actionId)
    }
    if (!persisted || persisted.closed) throw generationError('GENERATION_CLOSED')
    if (options.timeoutMs !== undefined && !Number.isSafeInteger(persisted.opened.startedAt + options.timeoutMs)) throw generationError('GENERATION_CLOCK_INVALID')
    const expiresAt = Math.min(persisted.expiresAt, options.timeoutMs === undefined ? persisted.expiresAt : persisted.opened.startedAt + options.timeoutMs)
    const limits = persisted.limits && { ...persisted.limits, total: Math.min(persisted.limits.total, options.maxAttempts ?? persisted.limits.total) }
    if (expiresAt < persisted.expiresAt || limits && limits.total < persisted.limits!.total) {
      await commit([{ type: 'context/action', version: 1, op: 'constrain', ownerSessionId, actionId: persisted.opened.actionId, trustedAt: Math.max(Date.now(), persisted.trustedAt), expiresAt, ...(limits ? { limits } : {}) }])
      persisted = state(persisted.opened.actionId)!
    }
    const clock = generationClock(persisted.opened.startedAt, persisted.expiresAt, persisted.trustedAt, options.signal ? AbortSignal.any([action.signal, options.signal]) : action.signal, options.start)
    const generation=new OwnedGenerationAction(execution?copyConversationData(persisted):persisted, clock, {
      view, execution, ownerSessionId, incarnation, assertOpen: execution ? () => {assertAction();source.assertHeld();if(!execution.owner.ownsAction(action))throw generationError('GENERATION_UNSUPPORTED')} : action.assertOpen, read: state,
      append: async (events, current) => { await commit(events, current) },
      settle: async event => { await receipt(remember(source.generation.capture(event),[event],source)) },
      captureClose: event => {
        const capture = remember(source.generation.capture(event),[event])
        retained.add(capture)
        const original = retainGenerationClose(capture, outcome => {acknowledge(capture,outcome);retained.delete(capture)})
        return { settle: () => own(original.settle()) }
      },
      phase: async (recovery, phase, current) => { await receipt(remember(action.captureGenerationRecovery(recovery, phase, current),[])) },
    }, { maxAttempts: options.maxAttempts, passiveGeneration:passive, localTest: options.selectedClient ? { enabled: localTest?.enabled === true, selectedClient: options.selectedClient } : localTest })
    if(execution){const assert=generation.assertOpen,methods=new Map<string,unknown>();for(const name of Object.getOwnPropertyNames(OwnedGenerationAction.prototype)){const field=Object.getOwnPropertyDescriptor(OwnedGenerationAction.prototype,name);if(name!=='constructor'&&field&&'value'in field&&typeof field.value==='function')methods.set(name,field.value)}executionGenerations.set(generation,{execution,action,methods,assert:()=>{source.assertHeld();Reflect.apply(assert,generation,[])},...purpose==='approval'&&openedProof?{approvalAudit(domain){assertExecutionGeneration(execution,generation,action);if(audits.has(generation.actionId))throw generationError('GENERATION_UNSUPPORTED');const audit=createOriginalManagedApprovalAudit(domain,action as ManagedAction<FactOutcome>,source,openedProof!.capture,openedProof!.outcome);audits.set(generation.actionId,audit);return audit}}:{}})}
    return generation
  } }
}
