import type {Agent,AgentDeps,AgentConfig,AgentInputOptions} from './types.ts'
import type {AgentGenerationAction,AgentGenerationLifecycle,AgentGenerationDependencies} from './generation.ts'
import type {SessionRequestContext,SuccessfulInstructionHandoff} from './request-context.ts'
import type {FactOutcome,ManagedAction,PreparedInputResult,GenerationOrigin,ImageInput} from '@i-harness/core-session'
import type {ManagedExecutionDomain} from '@i-harness/core-session/internal/execution'
import type {ManagedExecutionAttachment} from '../../../session-persistence/src/execution-internal.ts'
import type {ExecutionHookChannel} from '@i-harness/core-plugin'
import type {AcceptedInstructionBatch,AcceptedCallDescriptor} from '@i-harness/core-tools'
import type {CompactionRunOptions,CompactionResult} from '@i-harness/compaction'
export interface ManagedGenerationAction extends Omit<AgentGenerationAction,'adopt'|'adoptManual'|'adoptDelegated'> {
 adoptExecution(identity:ManagedExecutionDomain['identity'],inputId:string,preparation:PreparedInputResult,signal:AbortSignal):void
 adoptManualExecution(identity:ManagedExecutionDomain['identity'],signal:AbortSignal):void
 adoptDelegatedExecution(identity:ManagedExecutionDomain['identity'],origin:Extract<GenerationOrigin,{kind:'delegated-input'}>,signal:AbortSignal):void
}
export interface ManagedGenerationLifecycle extends Omit<AgentGenerationLifecycle,'open'> {open(...args:Parameters<AgentGenerationLifecycle['open']>):Promise<ManagedGenerationAction>}
export type ManagedGenerationFactory=(action:ManagedAction<FactOutcome>,dependencies?:AgentGenerationDependencies)=>ManagedGenerationLifecycle
export interface ManagedInputPreparation {prepare(input:import('@i-harness/core-session').PendingInput,generation:ManagedGenerationAction):Promise<PreparedInputResult|undefined>;cancelUnpromoted(result:PreparedInputResult):Promise<void>;close():Promise<void>}
export interface ManagedAcknowledgedFact {readonly capture:import('@i-harness/core-session').CapturedActionFact<FactOutcome>;readonly outcome:Extract<FactOutcome,{kind:'committed'}>}
export interface ManagedSuccessfulInstructionHandoff extends Omit<SuccessfulInstructionHandoff,'outcome'|'calls'> {
 readonly domain:ManagedExecutionDomain
 readonly action:ManagedAction<FactOutcome>
 readonly accepted:ManagedAcknowledgedFact
 readonly outcome:ManagedAcknowledgedFact['outcome']
 readonly calls:readonly (AcceptedCallDescriptor&ManagedAcknowledgedFact)[]
}
export interface ManagedRequestContext extends Omit<SessionRequestContext,'succeeded'> {managedSucceeded(handoff:ManagedSuccessfulInstructionHandoff):AcceptedInstructionBatch|undefined}
export interface ManagedAgentInputOptions extends Omit<AgentInputOptions,'generation'> {generation?:ManagedGenerationAction}
export interface ManagedAgent extends Omit<Agent,'run'|'runAdmitted'|'followup'|'compact'> {
 run(task:string,signal?:AbortSignal,images?:ImageInput[],inputId?:string,options?:ManagedAgentInputOptions):ReturnType<Agent['run']>
 runAdmitted:ManagedAgent['run']
 followup(message:string,signal?:AbortSignal,options?:ManagedAgentInputOptions):ReturnType<Agent['followup']>
 compact(instructions?:string,options?:CompactionRunOptions&{generation?:ManagedGenerationAction}):Promise<CompactionResult>
}
export interface ManagedAgentDeps extends Omit<AgentDeps,'session'|'factOwner'|'modelCallOrigin'|'generationFactory'|'generationLifecycle'|'generationAction'|'inputPreparationFactory'|'inputPreparation'|'sharedGeneration'|'sharedBudget'|'requestContext'> {
 readonly execution:ManagedExecutionAttachment
 readonly domain:ManagedExecutionDomain
 readonly hooks:ExecutionHookChannel
 modelCallOrigin:object
 generationFactory:ManagedGenerationFactory
 inputPreparationFactory?:(action:ManagedAction<FactOutcome>)=>ManagedInputPreparation
 requestContext?:ManagedRequestContext
}
export type ManagedAgentHost=ManagedAgentDeps&AgentConfig
