import { canonicalJsonData, isStrictFactData, committedFactSeqs, isOwnedSettlementSource } from '@i-harness/core-session'
import type { ModelOriginState } from './model-origin.ts'
import type { ModelOriginExpectation } from '@i-harness/core-tools/model-origin'
import type { AcceptedExchange } from '../agent/request-context.ts'
import type { AgentGenerationAction } from '../agent/generation.ts'
import type { ManagedAction, ProducerFactOutcome, SessionView, SettlementFacts } from '@i-harness/core-session'
import type { PreparedCall, RetainedToolOutcome } from '@i-harness/core-tools'
import type { BatchCall, ExecuteToolCallsOptions } from './types.ts'

export type LiveBatchToken = object
export type CheckpointEvidence = { site: 'retained-dispatch' | 'raw-checkpoint'; error: unknown; index: number; prepared?: PreparedCall; retained?: RetainedToolOutcome }
export interface LiveInvocation {
  readonly view: SessionView
  readonly action: ManagedAction<ProducerFactOutcome>
  registerBatchSource(drain: () => Promise<void>): SettlementFacts<ProducerFactOutcome>
  assertInvocationOpen(): void
  invalidate(): void
}
interface BatchState {
  token: LiveBatchToken; invocation: LiveInvocation; scope: object; batch: BatchCall[]; options: ExecuteToolCallsOptions
  source?: SettlementFacts<ProducerFactOutcome>; error?: unknown; accepted?: AcceptedExchange; members?: readonly string[]; claimed?: Set<number>
  phase: 'prepared' | 'marked' | 'reserved' | 'consumed'
}
type InvocationState = { tokens: Set<LiveBatchToken>; origin?: ModelOriginState; input?: { outcome: object; capture?: object; draft: object }; generations: Set<AgentGenerationAction>; accepted: Map<AcceptedExchange, { generation: AgentGenerationAction; capture: object; members: readonly string[]; batch: BatchCall[]; scope?: object; closed: boolean; issued: boolean }> }
const invocations = new WeakMap<LiveInvocation, InvocationState>()
const tokens = new WeakMap<LiveBatchToken, BatchState>()
const optionsTokens = new WeakMap<ExecuteToolCallsOptions, LiveBatchToken>()

/** Created only by the managed Agent's actual withFactAction owner. */
export function createLiveInvocation(view: SessionView, action: ManagedAction<ProducerFactOutcome>, register: LiveInvocation['registerBatchSource'], origin?: ModelOriginState): LiveInvocation {
  const invocation: LiveInvocation = Object.freeze({ view, action,
    registerBatchSource(drain: () => Promise<void>) { invocation.assertInvocationOpen(); return register(drain) },
    assertInvocationOpen() {
      if (!invocations.has(invocation)) throw new Error('Live invocation has expired')
      action.signal.throwIfAborted(); action.assertOpen()
    },
    invalidate() {
      for (const token of invocations.get(invocation)?.tokens ?? []) releaseLiveBatch(token)
      invocations.delete(invocation)
    },
  })
  invocations.set(invocation, { tokens: new Set(), origin, generations: new Set(), accepted: new Map() })
  return invocation
}
export function issueLiveBatch(invocation: LiveInvocation, scope: object, batch: BatchCall[], options: ExecuteToolCallsOptions, accepted?: AcceptedExchange): LiveBatchToken {
  invocation.assertInvocationOpen()
  const token = Object.freeze({})
  const owner = invocations.get(invocation)!
  const receipt = accepted && owner.accepted.get(accepted)
  if (owner.origin && (!receipt?.closed || receipt.issued || receipt.batch !== batch || receipt.scope !== scope || receipt.members.length !== batch.length || receipt.members.some((member,index)=>member !== memberData(batch[index]!)))) throw new Error('Original accepted batch required')
  if (receipt) receipt.issued = true
  tokens.set(token, { token, invocation, scope, batch, options, phase: 'prepared', accepted, members: receipt?.members, claimed: new Set() })
  optionsTokens.set(options, token); invocations.get(invocation)!.tokens.add(token)
  return token
}
/** Capture before resolveBatchFacts creates its options facade. */
export function prepareLiveBatch(options: ExecuteToolCallsOptions, view: SessionView, batch: BatchCall[]): LiveBatchToken | undefined {
  const token = optionsTokens.get(options), state = token && tokens.get(token)
  if (!state || state.options !== options || state.batch !== batch || state.invocation.view !== view || state.phase !== 'prepared') return undefined
  state.invocation.assertInvocationOpen()
  return token
}
export function bindLiveBatchSource(token: LiveBatchToken | undefined, source: SettlementFacts<ProducerFactOutcome>): void {
  const state = token && tokens.get(token)
  if (state && state.phase === 'prepared' && !state.source) state.source = source
}
/** Called by join only after the original source.close resolves. */
export function markLiveBatchClosed(token: LiveBatchToken | undefined, source: SettlementFacts<ProducerFactOutcome>, error: unknown): void {
  const state = token && tokens.get(token)
  if (!state || state.source !== source || state.phase !== 'prepared') return
  try { state.invocation.assertInvocationOpen() } catch { return }
  state.error = error; state.phase = 'marked'
}
export function reserveLiveContinuation(token: LiveBatchToken | undefined, error: unknown, invocation: LiveInvocation | undefined, scope: object, batch: BatchCall[]): boolean {
  const state = token && tokens.get(token)
  if (!state || state.phase !== 'marked' || state.error !== error || state.invocation !== invocation || state.scope !== scope || state.batch !== batch || !invocations.has(invocation!)) return false
  state.phase = 'reserved'
  return true
}
export function consumeLiveContinuation(token: LiveBatchToken): void {
  const state = tokens.get(token)
  if (!state || state.phase !== 'reserved') throw new Error('Live batch continuation is unavailable')
  state.phase = 'consumed'
  releaseLiveBatch(token)
}
export function releaseLiveBatch(token: LiveBatchToken): void {
  const state = tokens.get(token)
  if (!state) return
  optionsTokens.delete(state.options); invocations.get(state.invocation)?.tokens.delete(token); tokens.delete(token)
}

function memberData(call: BatchCall): string {
  const value = {callId:call.callId,eventSeq:call.eventSeq,name:call.name,args:call.args}
  if (!isStrictFactData(value) || typeof call.eventSeq !== 'number') throw new Error('Closed accepted member required')
  return canonicalJsonData(value)
}
export function retainModelInput(invocation: LiveInvocation | undefined, draft: object, outcome: object, capture?: object): void {
  const owner=invocation && invocations.get(invocation);if(!owner?.origin)return
  invocation!.assertInvocationOpen();committedFactSeqs(outcome as ProducerFactOutcome)
  if(owner.input || !capture)throw new Error('Original input capture required')
  owner.input={draft,outcome,capture}
}
export function retainModelGeneration(invocation: LiveInvocation | undefined, generation: AgentGenerationAction | undefined): void {
  const owner=invocation && invocations.get(invocation);if(!owner?.origin)return
  invocation!.assertInvocationOpen();if(!owner.input||!generation)throw new Error('Original promoted generation required')
  generation.assertOpen();owner.generations.add(generation)
}
export function retainModelAcceptance(invocation: LiveInvocation | undefined, accepted: AcceptedExchange, capture: object | undefined, generation: AgentGenerationAction | undefined, batch: BatchCall[]): void {
  const owner=invocation && invocations.get(invocation);if(!owner?.origin)return
  invocation!.assertInvocationOpen()
  if(!owner.input || !capture || !generation || !owner.generations.has(generation) || owner.accepted.has(accepted))throw new Error('Original acceptance required')
  committedFactSeqs(accepted.outcome);generation.assertOpen()
  owner.accepted.set(accepted,{generation,capture,members:Object.freeze(batch.map(memberData)),batch,closed:false,issued:false})
}
export function retainAcceptedClose(invocation: LiveInvocation | undefined, accepted: AcceptedExchange, generation: AgentGenerationAction | undefined, scope: object | undefined): void {
  const owner=invocation && invocations.get(invocation);if(!owner?.origin)return
  invocation!.assertInvocationOpen();const record=owner.accepted.get(accepted)
  if(!record||record.generation!==generation||record.closed||!scope)throw new Error('Original accepted close required')
  record.closed=true;record.scope=scope
}
const proofs=new WeakMap<object,{state:BatchState;index:number;prepared:PreparedCall;taken:boolean}>()
export function attachModelMember(token: LiveBatchToken | undefined,index:number,prepared:PreparedCall,registry:import('@i-harness/core-tools').ToolRegistry): void {
  const state=token && tokens.get(token), owner=state && invocations.get(state.invocation)
  if(!owner?.origin)return
  state!.invocation.assertInvocationOpen()
  if(owner.origin.registry!==registry||!state!.source||!isOwnedSettlementSource(owner.origin.view,state!.source)||state!.claimed!.has(index)||state!.members?.[index]!==memberData(state!.batch[index]!))throw new Error('Original model member required')
  state!.source.assertHeld();state!.claimed!.add(index)
  const proof=Object.freeze({});proofs.set(proof,{state:state!,index,prepared,taken:false})
  owner.origin.driver.attach(prepared,proof)
}
export function takeModelMember(origin:ModelOriginState,proof:object,expected:ModelOriginExpectation): import('@i-harness/core-tools/model-origin').OriginalModelMemberPermit {
  const member=proofs.get(proof)
  const check=()=>{
    if(!member)throw new Error('Original member proof required')
    const {state,index,prepared}=member,owner=invocations.get(state.invocation)
    if(!owner||owner.origin!==origin||!origin.consumed||!owner.input||!state.accepted||!owner.accepted.get(state.accepted)?.closed||tokens.get(state.token)!==state)throw new Error('Expired model member')
    state.invocation.assertInvocationOpen();state.options.signal?.throwIfAborted();state.source?.assertHeld()
    if(state.phase!=='prepared'||expected.registry!==origin.registry||expected.prepared!==prepared||expected.view!==origin.view||expected.source!==state.source||state.members?.[index]!==memberData({callId:expected.callId,eventSeq:expected.callEventSeq,name:expected.name,args:expected.args})||state.members[index]!==memberData(state.batch[index]!))throw new Error('Foreign model member')
  }
  check();if(member!.taken)throw new Error('Model member already taken');member!.taken=true
  let issued=false
  const permit=Object.freeze({assertCurrent:check,takeExecSourceIssuer(){
    if(this!==permit)throw new Error('Foreign model permit receiver')
    check();if(issued)throw new Error('Exec source issuer already taken');issued=true
    const action=member!.state.invocation.action
    if(origin.factOwner.view!==origin.view||origin.factOwner.ownsAction?.(action)===false)throw new Error('Original model action required')
    let captured=false,registered=false
    const issuer:import('@i-harness/core-tools/model-origin').OriginalExecSourceIssuer=Object.freeze({
      assertAdmissionCurrent(){if(this!==issuer)throw new Error('Foreign Exec issuer receiver');check()},
      captureSource(binding:import('@i-harness/core-tools/model-origin').ExecSourceBinding,recipientCurrent:()=>boolean){
        if(this!==issuer)throw new Error('Foreign Exec issuer receiver');check()
        if(!registered||captured||binding.callSeq!==expected.callEventSeq||binding.recipientSessionId!==expected.prepared.exec.sessionId||binding.sourceNamespace!=='exec')throw new Error('Foreign Exec source binding')
        captured=true
        return action.captureExecDeliverySource({type:'agent/delivery-source',version:1,kind:'exec',recipientSessionId:binding.recipientSessionId,generationId:binding.generationId,sourceNamespace:'exec',sourceId:binding.sourceId,callSeq:binding.callSeq,delivery:binding.delivery},()=>{try{check();return recipientCurrent()}catch{return false}})
      },
      registerCompletion(drain:()=>Promise<void>){if(this!==issuer)throw new Error('Foreign Exec issuer receiver');check();if(registered)throw new Error('Exec completion already registered');registered=true;return action.registerSettlementSource(drain)},
    })
    return issuer
  }})
  return permit
}
