import {TeamMountRecoveryRequired,isOriginalTeamRecoveryPort,type TeamMountHandle,type createOriginalTeamRecoveryPort} from '@i-harness/agent-team'
import {associateOriginalTeamRetry} from './host-team-recovery.ts'
import {mountOwnedRewind,withManagedRewindFacts,type OwnedRewindHandle} from './owned-rewind.ts'
import {associateOriginalManagedRewind} from './host-managed-rewind.ts'
import {originalFilesystemPolicyFor} from './execution-runtime.ts'
import {types} from 'node:util'
import {AsyncLocalStorage} from 'node:async_hooks'
import {firstPartySelectionFor} from './first-party-selection.ts'
import {associateOriginalManagedExecution} from './host-managed-execution.ts'
import {mountOwnedWorkflow} from './owned-workflow.ts'
import {associateOriginalHostAssemblyObserver} from './host-assembly-observer.ts'
import {managedExecutionStatus} from '@i-harness/session-persistence/internal/retained-inspection'
import {createExecutorExecutionCache} from './durable-session.ts'
import {createManagedExecutionRuntime,createManagedExecutionRuntimeWithRegistry} from './managed-assembly.ts'
import {createOwnedPostTurnLifetime} from './service/owned-post-turn.ts'
import {mountOwnedShell,type OwnedShellOptions} from './owned-shell.ts'
import {mountOwnedCode,type OwnedCodeOutput} from './owned-code.ts'
import {createContextOutputTools} from '@i-harness/context-output'
import {receivedExecutionInputsFor} from './lifecycle/execution-inputs.ts'
import {createToolResultRetention} from './lifecycle/result-retention.ts'
import {subscribeManagedExecution,subscribeManagedExecutionReadiness,assertOriginalTeamDeliveryReceipt} from '@i-harness/core-session/internal/execution'
import {supportsManagedServiceOptions} from './service/execution-mode.ts'
import {createContext,captureExecutionHookChannel,type PluginContext} from '@i-harness/core-plugin'
import { createResidentActivation, type ResidentActivationController } from './lifecycle/resident-activation.ts'
// packages/session-executor/src/service.ts — R-C0 (engine-owned posture).
// The GLOBAL per-session service. A-region owns the per-session serial lane
// (packages/core-agent/src/executor.ts: createSessionExecutor over
// { session, agent, inbox } — four-tier input admits + serial pump + drain);
// THIS module is a thin registry wrapper over those instances and owns the
// get-or-create assembly lifecycle, the onAssembly bridge attach point, and
// the service-level submit pacing. The web host owns only transport.
//
// Naming note (M26 execution): the C-plan defined this GLOBAL surface as
// `SessionExecutor`, but A-region had ALREADY landed `SessionExecutor` as the
// PER-SESSION lane — so the global one is `SessionService`
// (createSessionService / SessionServiceOptions). A's sessionId-keyed
// SessionExecutorRegistry pattern is not re-exported: this class IS the
// registry (keyed by session id, one lane each).
//
// A-plan adaptation (verified at execution): the plan's
// `submit(sessionId, prompt, signal)` mapped to "tier-0 send with an
// in-memory per-session chain". The chain is now A's OWN per-session serial
// lane (submit: { tier: "send" }); the pacing chain here only skips aborted
// queued turns. A's `drain()` REJECTS on the first turn failure (CLI
// exit-code contract) — this service REJECTS submit with that error so the
// web-host opener maps the rejection to an `{status:"error"}` frame.
import { createHash, randomUUID } from "node:crypto"
import { subscribe, validateImages, contextStateFromBudget, isBoundDeliveryInput, isDeliveryExecutable, isManagedFactOwner, type AdmittedInput, type AsyncInbox, type SessionContextState, type ImageInput, type SessionView as Session, type ManagedAction, type ProducerFactOutcome } from "@i-harness/core-session"
import { openExecutorDocument } from './lifecycle/managed-document.ts'
import { receivedInputsFor } from './lifecycle/received-inputs.ts'
import { createCodeFinalOutputRetention } from './lifecycle/code-final-output-retention.ts'
import { createDeliveryDrain, isRetryableDeliveryError } from './service/delivery-drain.ts'
import { readOwnedDeliveryState } from '../../core-session/src/managed/view.ts'
import { readDeliveryIndex } from '../../core-session/src/conversation/delivery.ts'
import { prepareInputExecution } from './lifecycle/input-preparation.ts'
import { prepareExecutionInput } from './lifecycle/execution-input-preparation.ts'
import { runManualGeneration } from './lifecycle/manual-generation.ts'
import { completeSubmission } from './service/submission-completion.ts'
import { runPostSubmit } from './service/post-submit.ts'
import type { SandboxMode } from "@i-harness/sandbox"
import { createSessionExecutor, type SessionExecutor as SessionTurnLane, type ReasoningEffort } from "@i-harness/core-agent"
import { modelFailureFacts, type ModelClient } from "@i-harness/llm-seam"
import { registerSubagent, projectWorkflowRows, ParentNotificationStoppedError, inspectTaskProjection, reconcileTaskProjection, inspectJobRecordProjection, type AgentTaskView, type ParentInputAdmission, type RegisterSubagentOptions, type RegisterSubagentResult, type TaskProjectionIssue } from "@i-harness/subagent"
import type { SessionMeta } from "@i-harness/session-persistence"
import type { Telemetry } from "@i-harness/telemetry"
import { diagnosticsFor } from "@i-harness/diagnostics"
import { createContextStateReader } from "./service/context-state.ts"
import { createResultPageReader } from './service/result-reader.ts'
import { createInstructionEnvironment, createProjectInstructionEnvironment } from './context/instructions/index.ts'
import type { ResultPageQuery, ResultPageResult } from '@i-harness/context-output'

// W6 T6: ONE module-scope handle for this file's single report. The phase is
// `session`: the message is about THIS session's resolved model binding (a
// window-less binding disables auto-compaction despite the requested config),
// and the service is the per-session registry that owns the assembly
// lifecycle. With nothing installed the handle delegates to console.warn
// verbatim (one argument) — unset mode is the pre-migration bytes.
const d = diagnosticsFor("session")
import {
  createSessionAssembly,
  ModelUnavailableError,
  type AssemblyOptions,
  type SessionAssembly,
  type SessionProjectContext,
} from "./assembly.ts"

export type SessionModelBindingResult =
  | { status: "unconfigured"; reason: string }
  | { status: "invalid"; reason: string; providerId?: string; modelId?: string }
  | {
      status: "ready"
      binding: {
        budgetBinding?: import("@i-harness/llm-seam").ModelBudgetBinding
        contextMetadata?: import("@i-harness/core-session").ContextBindingMetadata
        model: ModelClient
        providerId: string
        modelId: string
        label: string
        protocol?: string
        reasoningEffort?: ReasoningEffort
        reasoningEfforts?: ReasoningEffort[]
        contextWindow?: number
        /** M72 Ⅱ: the resolved output cap. Absent → nothing was resolved, and
         * nothing is defaulted in its place (the adapter sends none). */
        maxOutputTokens?: number
        imageInput?: true
      }
    }

function captureCodeModeConfig(value:import('@i-harness/code-mode').CodeModeConfig):import('@i-harness/code-mode').CodeModeConfig {
 if(!value||typeof value!=='object'||types.isProxy(value)||![null,Object.prototype].includes(Object.getPrototypeOf(value)))throw TypeError('Original Code configuration required')
 const fields=Object.getOwnPropertyDescriptors(value),out:Record<string,unknown>={},allowed=new Set(['mode','memoryLimitMb','cpuTimeMs','maxActiveCells','maxPendingCalls','maxSourceBytes','maxResultBytes','maxStoreBytes','defaultYieldTimeMs','defaultOutputTokens'])
 for(const key of Reflect.ownKeys(fields)){if(typeof key!=='string'||!allowed.has(key)||!('value'in fields[key]!))throw TypeError('Original Code configuration data required');const item=fields[key]!.value;if(item!==undefined&&typeof item!=='string'&&typeof item!=='number')throw TypeError('Original Code configuration scalar required');if(fields[key]!.enumerable)out[key]=item}
 return Object.freeze(out)
}

/** Task 4: the installable half of a resolved binding — a `ready` result with
 * the status discriminator stripped. What `rebindModel` takes from the host,
 * which resolved it (only the host owns the runtime and the wire's optional
 * protocol). Not exported: the public shape is `SessionModelBindingResult`. */
type ReadyModelBinding = Extract<SessionModelBindingResult, { status: "ready" }>["binding"]

/** M49 Task 11 (spec §8.1): one row of the real session queue projection.
 * `order` is the per-session FIFO ordinal; the running row is always
 * reported FIRST by queue() — the rest follow FIFO by `order`. */
export interface SessionQueueItem {
  id: string
  text: string
  delivery: "queue" | "steer"
  intent: "user" | "system"
  state: "queued" | "running"
  order: number
}

/** Ephemeral service queue truth, including post-turn settlement work.
 * revision increases across all sessions for this service instance. */
export interface SessionExecutionState {
  sessionId: string
  running: boolean
  queued: number
  revision: number
}

type SessionModelState =
  | Exclude<SessionModelBindingResult, { status: "ready" }>
  | { status: "ready"; providerId: string; modelId: string; label: string; protocol?: string; reasoningEffort?: ReasoningEffort; reasoningEfforts?: ReasoningEffort[]; imageInput?: true }

type PostTurnAction = Pick<ManagedAction<ProducerFactOutcome>, 'signal' | 'assertOpen'> & {
  readonly openGeneration?: import('@i-harness/llm-seam').TitleGenerationFactory
  readonly view: Session
  readonly facts: Pick<ManagedAction<ProducerFactOutcome>['facts'], 'metadata'>
}

export interface SessionServiceOptions extends AssemblyOptions {
  /** Internal explicit-tool managed composition; not the default feature builder. */
  managedRuntime?: Pick<import('./managed-assembly.ts').ManagedExecutionRuntimeOptions,'tools'|'systemPrompt'|'prepareInput'|'originalFilesystem'|'requireFilesystemPolicy'|'originalSchedule'|'originalApproval'|'approvalMode'|'compact'|'autoCompactionEnabled'> & {
    /** Owned callback mount over the original ctx. Retain exact cleanup before startup awaits. */
    mount?(ctx:PluginContext,retain:(cleanup:()=>void|Promise<void>)=>void):Promise<void>
    mountRegistry?:import('./managed-assembly.ts').ManagedRegistryFactory
    ownedWorkflow?:boolean
    ownedRewind?:{root:string;workspace:string}
    onTeamRecoveryRequired?(sessionId:string):void
    ownedTask?:{options(original:import('./managed-assembly.ts').ManagedRegistryConstruction,shared:{shell?:import('@i-harness/exec').ExecService;output?:import('./owned-shell.ts').OwnedShellOutput;codeConfig?:import('@i-harness/code-mode').CodeModeConfig}):Promise<Omit<RegisterSubagentOptions,'managedParent'|'parentNotify'|'parentSession'|'factOwner'|'getParentModel'|'deferRestoredWork'>>}
    mountDefaultSurface?(original:import('./managed-assembly.ts').ManagedRegistryConstruction,live:{modelToolSchemas():import('@i-harness/llm-seam').ToolSchema[];modelBinding():import('./managed-assembly.ts').ManagedExecutionModelBinding;task?:RegisterSubagentResult;parentNotify?:ParentInputAdmission;shell?:import('@i-harness/exec').ExecService;output?:import('./owned-shell.ts').OwnedShellOutput;retainTeamRecovery(handle:TeamMountHandle,port:ReturnType<typeof createOriginalTeamRecoveryPort>):void}):Promise<import('./managed-assembly.ts').OwnedDefaultSurface>
    acquireInstructions?(sessionId:string,execution:import('../../session-persistence/src/execution-internal.ts').ManagedExecutionAttachment,retain:(cleanup:()=>void|Promise<void>)=>void):Promise<import('./managed-assembly.ts').OwnedInstructionBinding>
    ownedTitle?:{enabled:boolean;titleMaxOutputTokens?:number;timeoutMs?:number}
    ownedShell?:OwnedShellOptions
    ownedCode?:{config?:import('@i-harness/code-mode').CodeModeConfig;configFor?(sessionId:string):import('@i-harness/code-mode').CodeModeConfig;acquireOutput(sessionId:string,retain:(cleanup:()=>void|Promise<void>)=>void):OwnedCodeOutput|Promise<OwnedCodeOutput>}
  }
  /** Read-only host authority; never invokes execution project setup. */
  resultReadScopeFor?: import('./lifecycle/result-store.ts').ResultReadScopeResolver
  /** Loaded settings only; never resolves authentication or constructs a model client. */
  modelMetadataFor?: (sessionId: string, meta: SessionMeta | undefined) => import("@i-harness/core-session").ContextBindingMetadata | undefined | Promise<import("@i-harness/core-session").ContextBindingMetadata | undefined>
  /** Host structural management shares this admission boundary with all writers. */
  sessionOperation?: { run<T>(id: string, operation: () => Promise<T>): Promise<T>; assertOpen(id: string): void }
  /** Bind the session once; its returned getter follows current membership. */
  projectContextFor?: (sessionId: string) => Promise<() => SessionProjectContext | undefined>
  executionAuthorityFor?: (sessionId: string) => Promise<NonNullable<AssemblyOptions["executionAuthority"]>>
  windowsSandboxBackendFor?: () => "legacy" | "psec" | "wsl"
  wslExecutionFor?: () => AssemblyOptions["wslExecution"] | Promise<AssemblyOptions["wslExecution"]>
  webSearchModeFor?: () => AssemblyOptions["webSearchMode"]
  transformPrompt?: (assembly: SessionAssembly, prompt: string) => Promise<string>
  /** Host-owned post-turn work runs within this session's submit lane. Failure
   * is reported but never changes a successfully completed Agent turn. */
  afterSuccessfulSubmit?: (sessionId: string, assembly: SessionAssembly, limits: { contextWindow?: number; maxOutputTokens?: number; budgetBinding?: import('@i-harness/llm-seam').ModelBudgetBinding }, action: PostTurnAction) => Promise<void>
  /** Trusted host extension snapshot, re-read for each new assembly. */
  extensionsFor?: (sessionId: string) => Promise<{
    options: Pick<AssemblyOptions, "skills" | "pluginMcp" | "pluginAgents" | "pluginAgentsEphemeral" | "hookContext">
    mount?: (assembly: SessionAssembly) => Promise<(() => void | Promise<void>) | void>
    update?: (assembly: SessionAssembly) => Promise<void>
  }>
  beforeDispose?: () => Promise<void>
  /** Shared host event stream (also handed to each assembly). */
  telemetry?: Telemetry
  /** Metadata source for an assembly's FIRST build (the tier-1 model chain
   * input, e.g. session.meta.modelSelection). Absent → no meta. */
  loadMeta?: (sessionId: string) => Promise<SessionMeta | undefined>
  /** Legacy per-assembly model resolution. Absent or unresolved means the
   * assembly follows modelPolicy (production defaults to required). */
  modelBuilder?: (sessionId: string, meta: SessionMeta | undefined) => Promise<ModelClient | undefined>
  /** Atomic per-session model resolution. The local structural type keeps
   * session-executor independent of provider-runtime; app composition adapts
   * the provider result at this boundary. */
  modelBindingFor?: (
    sessionId: string,
    meta: SessionMeta | undefined,
  ) => Promise<SessionModelBindingResult>
  /** Resolve a host-seeded session per id. When defined, it takes precedence
   * over the static `session` option for every assembly build. */
  sessionFor?: (sessionId: string) => Promise<Session | undefined>
  /** M31 T3: per-session context-window resolver — evaluated at EVERY assembly
   * build (meta-aware, so session.modelSelection drives the window). When
   * defined it ALWAYS wins over the static AssemblyOptions.contextWindow
   * (undefined → fail-closed, get_context_remaining not registered); absent →
   * the static value (legacy path). */
  contextWindowFor?: (sessionId: string, meta: SessionMeta | undefined) => number | undefined
  /** M32 T3: per-session reasoning-effort resolver — evaluated at EVERY
   * assembly build (meta-aware: session.meta.modelSelection.reasoningEffort).
   * When defined it ALWAYS wins over the static AssemblyOptions.
   * reasoningEffort; absent → the static value (or never set). */
  reasoningEffortFor?: (sessionId: string, meta: SessionMeta | undefined) => ReasoningEffort | undefined
}

interface SessionSubmitOptions {
  context?: string; images?: ImageInput[]; clientToken?: string; admittedInputId?: string
  /** Trusted host preparation callback; never comes from model or wire data. */
  prepareInput?: (assembly: SessionAssembly, prompt: string) => Promise<string>
}
/** Original private execution publication; it never exposes a Session facade. */
export interface ManagedRuntimePublication {
 readonly sessionId:string
 readonly ctx:import('@i-harness/core-plugin').PluginContext
 readonly tools:import('@i-harness/core-tools').ToolRegistry
 readonly domain:import('@i-harness/core-session/internal/execution').ManagedExecutionDomain
 readonly execution:import('../../session-persistence/src/execution-internal.ts').ManagedExecutionAttachment
 observe():import('@i-harness/core-session/internal/execution').ExecutionObservation
 subscribe(listener:(event:import('@i-harness/core-session').SessionEvent)=>void):()=>void
}
export type ManagedRuntimeLifecycle={sessionId:string;owner:ManagedRuntimePublication;kind:'published'|'retiring'|'removed'}
export interface SessionService {
  /** Internal default-input adapter over the SAME private entry; no Session facade. */
  managedInputFor?(sessionId:string,requirements?:{completePreparation?:boolean;supplementalContext?:boolean}):Promise<{
    readonly inbox:Pick<AsyncInbox,'pending'|'admit'|'cancel'>
    observe():import('@i-harness/core-session/internal/execution').ExecutionObservation
  }|undefined>
  onManagedRuntimeLifecycle?(listener:(event:ManagedRuntimeLifecycle)=>void,options?:{includeExisting?:boolean}):()=>void
  instructionState?(sessionId: string, childSessionId?: string): import('./context/instructions/diagnostics.ts').InstructionReport
  refreshInstructions?(sessionId: string, childSessionId?: string, signal?: AbortSignal): Promise<import('./context/instructions/diagnostics.ts').InstructionReport>
  onInstructionsChanged?(sessionId: string, childSessionId: string | undefined, listener: () => void): () => void
  onExecutionSurfaceLifecycle?(listener: (event: { sessionId: string; assembly: SessionAssembly; kind: "published" | "retiring" | "removed" }) => void, options?: { includeExisting?: boolean }): () => void
  compact(sessionId: string, instructions?: string, signal?: AbortSignal): Promise<import('@i-harness/compaction').CompactionResult>
  /** Update plugin-owned capabilities without replacing sessions or agents. */
  refreshExtensions(): Promise<void>
  /** One prompt for one session (tier send). Serialized per session;
   * cross-session parallel. An aborted QUEUED submit never runs. REJECTS when
   * the session's turn lane failed (drain rejection → the host maps it to an
   * error frame). */
  submit(sessionId: string, prompt: string, signal: AbortSignal, options?: SessionSubmitOptions): Promise<void>
  assemblyFor(sessionId: string): Promise<SessionAssembly>
  /** Resolve serializable model state without constructing an assembly. */
  modelState(sessionId: string): Promise<SessionModelState>
  /** Actual owned prepared budget or validated saved facts; no provider request. */
  contextState(sessionId: string): Promise<SessionContextState>
  readResultPage?(sessionId: string, query: ResultPageQuery): Promise<ResultPageResult>
  /** Host-only Task projection integrity (D-01): read-only inspection, or an
   * explicit reconcile that writes warning markers. Never called by a tool. */
  taskProjectionIntegrity?(sessionId: string, options?: { reconcile?: boolean }): Promise<TaskProjectionIssue[]>
  /** Task 4 (F1): install a HOST-RESOLVED model binding for a session — the
   * `session/model/set` rebind. The host resolves because only it owns the
   * runtime and the wire's optional protocol (§4.2②); this method makes the
   * install reach the two REPORTING surfaces as well: the memoised binding
   * (what `modelState` and the dashboard row report — previously only
   * `closeSession` cleared it) and, when the session is LIVE, the assembly's
   * handle plus its label, and the binding's reasoning effort — the whole
   * resolved selection, so no field of it can go stale (review F-1; an absent
   * effort CLEARS the live one). It NEVER disposes an assembly: the live rebind
   * IS the point. Returns whether a live assembly was retargeted; false means
   * nothing was live, and the refreshed binding is what the next build in this
   * process starts from. A live idle rebind installs context/output limits and
   * the compactor with the client before updating the reported binding. Busy
   * sessions and active agent tasks reject rebind rather than mixing models. */
  rebindModel(sessionId: string, binding: ReadyModelBinding): boolean
  liveSession(sessionId: string): Session | undefined
  /** Writable document ownership for this service lifecycle, including while
   * an assembly is preparing or mounting. Never constructs an Agent or model.
   * Optional for older embedders; read-only paths must not call this method. */
  writableSessionFor?(sessionId: string, fallback?: (sessionId: string) => Promise<Session | undefined>): Promise<Session | undefined>
  /** Synchronous observation only; never resolves a model or constructs an Agent. */
  liveAssembly(sessionId: string): SessionAssembly | undefined
  hasAssembly(sessionId: string): boolean
  /** Service queue truth, including lane execution and post-turn settlement.
   * queued counts paced submits and pending inbox inputs from queue(). */
  queueState(sessionId: string): { running: boolean; queued: number }
  /** Future changes only, no replay. Emitted after queue bookkeeping, including
   * internal submits; final idle follows lane hooks/flush and host completion.
   * Optional for legacy embedders. Unsubscribe and close stop delivery. */
  onExecutionState?(listener: (state: SessionExecutionState) => void): () => void
  /** M49 Task 11 (spec §8.1): the REAL per-session queue projection —
   * service-front (pacing chain) rows merged with lane rows by public id;
   * the running row is first, the rest FIFO. Never fabricated: {} here means
   * literally no queued/running work for the session. */
  queue(sessionId: string): SessionQueueItem[]
  /** Cancel ONE queued row by its stable public id: the submit settles without
   * executing (never leaving the lane to turn). `cancelled: false` for an
   * unknown/already-finished row or a RUNNING one (whole-turn cancel is
   * session/cancel, not row cancel). */
  receivedInputFor(sessionId: string): Promise<Pick<AsyncInbox, 'pending' | 'admit' | 'cancel'>>
  cancelQueued(sessionId: string, id: string): Promise<{ cancelled: boolean }>
  /** Cancel the executing submission; queued submissions retain their own controllers. */
  cancelRunning?(sessionId: string): { cancelled: boolean }
  awaitDeliveryStop(sessionId: string): Promise<import('@i-harness/core-session').DeliveryCloseReceipt | undefined>
  /** M49 Task 12 (spec §8.2): the per-session task projection (assembly tasks
   * rows — subagent/job/workflow). Workflow rows are attributed to the session
   * that started the run (the run-level store is shared — another session's
   * workflow jobs never leak into this projection; runs started outside a
   * session surface belong to the run-level /workflow panel and appear in no
   * session's list). Never fabricated: a session with no live assembly answers
   * an honest empty list. */
  tasks(sessionId: string): AgentTaskView[]
  /** M49 Task 12: cancel ONE task through the owning assembly (its registries
   * hold the authority). An id with no owner (unknown session/unknown id)
   * throws the registry's not-found error — never a silent success. */
  cancelTask(sessionId: string, id: string): "cancellation-requested" | "already-finished"
  /** Fires once per future assembly. Opt in to synchronous attachment of
   * currently published assemblies; registration precedes that snapshot. */
  onAssembly(hook: (assembly: SessionAssembly) => void, options?: { includeExisting?: boolean }): () => void
  /** Changes the standing sandbox on existing and future assemblies. */
  updateSandboxMode(mode: SandboxMode): Promise<void>
  reconcileExecutionAuthority(sessionIds?: readonly string[]): Promise<void>
  executionBackendStatus(): Promise<readonly { sessionId: string; status: unknown }[]>
  /** Wait for this session's pending work/build/model resolution, remove its
   * cached state and assembly, and dispose only that assembly. A later
   * request resolves and builds it again. */
  closeSession(sessionId: string): Promise<void>
  /** Wait for active turns, then dispose every assembly best-effort. NEVER
   * closes a caller-owned telemetry stream or coordinator. */
  close(): Promise<void>
}

export function createSessionService(opts: SessionServiceOptions): SessionService {
  const assemblies = new Map<string, SessionAssembly>()
  const mountingAssemblies = new Map<string, SessionAssembly>()
  const writableSessions = new Map<string, Session>()
  const inputInboxes = new Map<string, AsyncInbox>()
  const loadingWriters = new Map<string, Promise<Session | undefined>>()
  const ownedAssemblies = () => new Map([...mountingAssemblies, ...assemblies])
  const lanes = new Map<string, SessionTurnLane>()
  type ManagedRuntime=ReturnType<typeof createManagedExecutionRuntime>
  const managedRuntimes=new Map<string,ManagedRuntime>()
  const managedPublications=new Map<string,{owner:ManagedRuntimePublication;retired:boolean;subscriptions:Set<()=>void>}>()
  const managedLifecycleListeners=new Set<(event:ManagedRuntimeLifecycle)=>void>()
  const notifyManaged=(event:ManagedRuntimeLifecycle)=>{for(const listener of [...managedLifecycleListeners])try{listener(event)}catch{/* Observers cannot change original ownership. */}}
  function publishManaged(sessionId:string,runtime:ManagedRuntime){
    const subscriptions=new Set<()=>void>();let record:{owner:ManagedRuntimePublication;retired:boolean;subscriptions:Set<()=>void>}
    const current=()=>{if(record.retired||managedPublications.get(sessionId)!==record||managedRuntimes.get(sessionId)!==runtime)throw Error('Original private runtime retired')}
    const owner:ManagedRuntimePublication=Object.freeze({sessionId,ctx:runtime.ctx,tools:runtime.tools,domain:runtime.domain,execution:runtime.execution,
      observe(){if(this!==owner)throw TypeError('Original private runtime receiver required');current();return runtime.execution.observe()},
      subscribe(listener:(event:import('@i-harness/core-session').SessionEvent)=>void){if(this!==owner||typeof listener!=='function')throw TypeError('Original private runtime listener required');current();const off=subscribeManagedExecution(runtime.domain,event=>{try{listener(event)}catch{/* Observer cannot change committed execution. */}});let active=true;const close=()=>{if(!active)return;active=false;subscriptions.delete(close);off()};subscriptions.add(close);return close},
    });record={owner,retired:false,subscriptions};managedPublications.set(sessionId,record);notifyManaged({sessionId,owner,kind:'published'})
  }
  function retireManaged(sessionId:string){const record=managedPublications.get(sessionId);if(!record||record.retired)return;record.retired=true;notifyManaged({sessionId,owner:record.owner,kind:'retiring'});for(const off of [...record.subscriptions])off()}
  function removeManaged(sessionId:string){const record=managedPublications.get(sessionId);if(!record)return;retireManaged(sessionId);managedPublications.delete(sessionId);notifyManaged({sessionId,owner:record.owner,kind:'removed'})}

  const managedTitles=new Map<string,ReturnType<typeof createOwnedPostTurnLifetime>>()
  const managedRecipients=new Map<string,ReturnType<ReturnType<typeof receivedExecutionInputsFor>['execDelivery']>>()
  const managedPrepubSettlers=new Map<string,()=>Promise<void>>()
  type TaskLifecycle={dispose():Promise<void>;drain():Promise<void>;journal():Promise<void>;activate():void;ready:Promise<void>;projectTasks():AgentTaskView[];cancelTask(id:string):'cancellation-requested'|'already-finished';projectionIntegrity():Promise<TaskProjectionIssue[]>;reconcileProjection():Promise<TaskProjectionIssue[]>}
  const managedTaskOwners=new Map<string,TaskLifecycle>()
  const managedWorkflowOwners=new Map<string,{list():import('@i-harness/exec').BackgroundJobView[];kill(id:string):'cancellation-requested'|'already-finished';journal():Promise<void>}>()
  const managedCodeMounts=new Map<string,import('@i-harness/code-mode').CodeModeMount>()
  const managedCodeStops=new Map<string,{flight:Promise<void>;failed:boolean}>()
  const managedStopReceipts=new Map<string,{recipient:ReturnType<ReturnType<typeof receivedExecutionInputsFor>['execDelivery']>;fenceId:string;settleSources?:()=>Promise<void>}>()
  const laneControls=(id:string):Omit<SessionTurnLane,'runAdmitted'>|undefined=>managedRuntimes.get(id)?.lane??lanes.get(id)
  type TeamRecovery={domain:import('@i-harness/core-session/internal/execution').ManagedExecutionDomain;handle:TeamMountHandle;port:ReturnType<typeof createOriginalTeamRecoveryPort>;resume:()=>Promise<void>;close:()=>Promise<void>;gate:PromiseWithResolvers<void>;pending:boolean;stopped:boolean;retry?:Promise<void>;stop?:Promise<void>}
  type CreatingAssembly = { teamRecovery?:TeamRecovery; work: Promise<unknown>; publicWork?:Promise<SessionAssembly>; managedWork?:Promise<ManagedRuntime>; cleanup?: () => Promise<void>; failed: boolean; assembly?: SessionAssembly; residentActivation: ResidentActivationController }
  const creating = new Map<string, CreatingAssembly>()
  const modelBindings = new Map<string, Promise<SessionModelBindingResult>>()
  const extensionRefreshes = new Map<string, Promise<void>>()
  const extensionCleanups = new Map<string, () => void | Promise<void>>()
  const hooks = new Set<(assembly: SessionAssembly) => void>()
  const hostAssemblyHooks = new Set<(assembly: SessionAssembly) => void>()
  const completeSelections=new Set<string>()
  const firstParty=firstPartySelectionFor(opts), firstPartySelections=new Map<string,Awaited<ReturnType<NonNullable<typeof firstParty>['prepare']>>>(), firstPartyFlights=new Map<string,Promise<void>>(), firstPartyEpochs=new Map<string,number>(), firstPartyRetained=new Set<string>()
  const managedCompatible=(id:string)=>!completeSelections.has(id)&&hooks.size===0&&(firstParty?firstPartySelections.get(id)?.kind==='managed':supportsManagedServiceOptions(opts))
  const validatingFirstParty=new Set<string>()
  const validateFirstParty=(id:string)=>{const selected=firstPartySelections.get(id);if(selected?.kind!=='managed')return;if(validatingFirstParty.has(id))throw Error('First-party currentness cannot reenter service');validatingFirstParty.add(id);try{selected.assertCurrent()}finally{validatingFirstParty.delete(id)}}
  const releaseFirstParty=async(id:string)=>{if(!firstPartyRetained.has(id))return;await firstParty?.release?.(id);firstPartyRetained.delete(id)}
  const firstPartyContext=new AsyncLocalStorage<{active:boolean}>()
  async function prepareFirstParty(id:string){
    if(firstPartyContext.getStore()?.active)throw Error('First-party selection cannot reenter service')
    if(!firstParty||firstPartySelections.has(id)||completeSelections.has(id)||privateEntries.has(id))return
    const existing=firstPartyFlights.get(id);if(existing)return existing
    const epoch=firstPartyEpochs.get(id)??0
    firstPartyRetained.add(id)
    const context={active:true};let releasing=false
    const flight=Promise.resolve().then(()=>firstPartyContext.run(context,async()=>{try{const selected=await firstParty.prepare(id);assertWritableOpen(id);if((firstPartyEpochs.get(id)??0)!==epoch)throw Error('First-party selection retired');selected.assertCurrent();if(completeSelections.has(id)||privateEntries.has(id)){releasing=true;await releaseFirstParty(id);return}if(selected.kind==='complete'||hooks.size){releasing=true;await releaseFirstParty(id);selectComplete(id);return}firstPartySelections.set(id,selected)}catch(error){if(!releasing)try{await releaseFirstParty(id)}catch(cleanup){throw new AggregateError([error,cleanup],'First-party selection cleanup failed',{cause:error})}throw error}finally{context.active=false}}))
    firstPartyFlights.set(id,flight);try{await flight}finally{if(firstPartyFlights.get(id)===flight){firstPartyFlights.delete(id);firstPartyEpochs.delete(id)}}
  }
  const selectComplete=(id:string)=>{if(privateEntries.has(id))throw Error('Private entry requires explicit complete compatibility adapter');completeSelections.add(id)}
  const privateCache=opts.coordinator?createExecutorExecutionCache({coordinator:opts.coordinator,assertOpen:assertWritableOpen}):undefined
  const privateEntries=new Set<string>()
  const managedRewinds=new Map<string,{handle:OwnedRewindHandle;runtime:ManagedRuntime}>()
  const managedIngress=new Map<string,Set<()=>Promise<void>>>()
  async function drainManagedIngress(id:string){const entries=managedIngress.get(id);if(!entries)return;for(const close of [...entries]){await close();entries.delete(close)}if(!entries.size)managedIngress.delete(id)}
  type SurfaceLifecycle = { sessionId: string; assembly: SessionAssembly; kind: "published" | "retiring" | "removed" }
  const surfaceListeners = new Set<(event: SurfaceLifecycle) => void>()
  const retiredSurfaces = new WeakSet<SessionAssembly>()
  const surfaceSubscriptions = new Map<SessionAssembly, () => void>()
  const ownsSurface = (id: string, assembly: SessionAssembly) => (assemblies.get(id) ?? mountingAssemblies.get(id)) === assembly
  const surfaceKind = (id: string, assembly: SessionAssembly): 'published' | 'retiring' =>
    closed || closing.has(id) || failedClose.has(id) || retiredSurfaces.has(assembly) || assembly.executionSurfaceState?.() === 'retired' ? 'retiring' : 'published'
  const deliverSurface = (listener: (event: SurfaceLifecycle) => void, event: SurfaceLifecycle) => {
    try { listener(event) } catch { /* Lifecycle observers cannot fail publication or cleanup. */ }
  }
  const notifySurface = (event: SurfaceLifecycle) => {
    for (const listener of [...surfaceListeners]) {
      if (event.kind !== 'removed' && !ownsSurface(event.sessionId, event.assembly)) break
      // A preceding consumer may synchronously revoke/remove this identity.
      if (event.kind === 'published' && surfaceKind(event.sessionId, event.assembly) !== 'published') break
      deliverSurface(listener, event)
    }
  }
  const retireSurface = (sessionId: string, assembly: SessionAssembly) => {
    if (!ownsSurface(sessionId, assembly) || retiredSurfaces.has(assembly)) return
    retiredSurfaces.add(assembly)
    notifySurface({ sessionId, assembly, kind: 'retiring' })
  }
  const removeSurface = (sessionId: string, assembly: SessionAssembly) => {
    surfaceSubscriptions.get(assembly)?.(); surfaceSubscriptions.delete(assembly)
    notifySurface({ sessionId, assembly, kind: 'removed' })
  }
  const executionListeners = new Set<(state: SessionExecutionState) => void>()
  const executionSubscriptions = new Map<string, () => void>()
  let executionRevision = 0
  const chains = new Map<string, Promise<void>>()
  const active = new Set<Promise<void>>()
  const closing = new Map<string, Promise<void>>()
  const telemetry = opts.telemetry
  function failureDiagnostics(error: unknown) {
    const modelFailure = modelFailureFacts(error)
    return { error: modelFailure?.message ?? "Session execution failed.", ...(modelFailure ? { modelFailure } : {}) }
  }
  let closed = false
  let defaultInstructions: ReturnType<typeof createProjectInstructionEnvironment> | undefined
  const instructions = () => opts.instructionEnvironment ?? (defaultInstructions ??= opts.instructionSettingsPath !== undefined ? createInstructionEnvironment({ settingsPath: opts.instructionSettingsPath }) : createProjectInstructionEnvironment())
  let currentSandbox = opts.sandbox
  const cancelledParents = new Set<string>()
  const notificationAdmissions = new Map<string, Promise<void>>()
  const notificationInputs = new Map<string, Set<string>>()
  const notificationControllers = new Map<string, Map<string, AbortController>>()
  type NotificationStop = {
    readonly inputId: string; readonly reason: 'parent stopped'
    inFlight?: Promise<boolean>; succeeded?: Promise<boolean>; lastAttempt?: Promise<boolean>
  }
  type NotificationStopOwner = { readonly sessionId: string; readonly assembly: SessionAssembly; readonly stops: Map<string, NotificationStop> }
  const notificationStops = new Map<SessionAssembly, NotificationStopOwner>()
  const assemblyDisposals = new WeakMap<SessionAssembly, { acknowledged: boolean; inFlight?: Promise<void>; succeeded?: Promise<void> }>()
  function releaseNotificationStops(assembly: SessionAssembly): void {
    if (!assemblyDisposals.get(assembly)?.acknowledged) return
    const owner = notificationStops.get(assembly)
    if (!owner) return
    for (const [inputId, stop] of owner.stops) if (stop.succeeded) owner.stops.delete(inputId)
    if (!owner.stops.size) notificationStops.delete(assembly)
  }
  function stopNotification(id: string, assembly: SessionAssembly, inputId: string): Promise<boolean> {
    let owner = notificationStops.get(assembly)
    if (!owner) { owner = { sessionId: id, assembly, stops: new Map() }; notificationStops.set(assembly, owner) }
    let stop = owner.stops.get(inputId)
    if (!stop) { stop = { inputId, reason: 'parent stopped' }; owner.stops.set(inputId, stop) }
    if (stop.inFlight || stop.succeeded) return (stop.inFlight ?? stop.succeeded)!
    let attempt: Promise<boolean>
    try { attempt = assembly.inbox.cancel(inputId, stop.reason) } catch (error) { attempt = Promise.reject(error) }
    stop.inFlight = stop.lastAttempt = attempt
    const record = stop
    void attempt.then(() => {
      record.succeeded = attempt
      if (record.inFlight === attempt) record.inFlight = undefined
      releaseNotificationStops(assembly)
    }, () => { if (record.inFlight === attempt) record.inFlight = undefined })
    return attempt
  }
  function startNotificationStops(sessionId?: string): Map<NotificationStop, Promise<boolean>> {
    const attempts = new Map<NotificationStop, Promise<boolean>>()
    for (const owner of notificationStops.values()) {
      if (sessionId !== undefined && owner.sessionId !== sessionId) continue
      for (const stop of owner.stops.values()) attempts.set(stop, stopNotification(owner.sessionId, owner.assembly, stop.inputId))
    }
    return attempts
  }
  async function joinNotificationStops(attempts: Map<NotificationStop, Promise<boolean>>, sessionId?: string): Promise<void> {
    // Admissions have joined. Include their late records on their original
    // attempt, retaining failures even after the live assembly was removed.
    for (const owner of notificationStops.values()) {
      if (sessionId !== undefined && owner.sessionId !== sessionId) continue
      for (const stop of owner.stops.values()) if (!attempts.has(stop)) attempts.set(stop, stop.lastAttempt!)
    }
    const results = await Promise.allSettled(attempts.values())
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason)
    if (errors.length) throw new AggregateError(errors, 'Parent notification Stop requires reconciliation')
  }
  function disposeOwnedAssembly(assembly: SessionAssembly): Promise<void> {
    let row = assemblyDisposals.get(assembly)
    if (!row) { row = { acknowledged: false }; assemblyDisposals.set(assembly, row) }
    if (row.inFlight || row.succeeded) return (row.inFlight ?? row.succeeded)!
    let attempt: Promise<void>
    try { attempt = assembly.dispose() } catch (error) { attempt = Promise.reject(error) }
    row.inFlight = attempt
    const record = row
    void attempt.then(() => {
      record.acknowledged = true; record.succeeded = attempt
      if (record.inFlight === attempt) record.inFlight = undefined
      releaseNotificationStops(assembly)
    }, () => { if (record.inFlight === attempt) record.inFlight = undefined })
    return attempt
  }
  const deliveryDrains = new Map<string, ReturnType<typeof createDeliveryDrain>>()
  const deliveryStops = new Map<string, { delivery: ReturnType<typeof receivedInputsFor>['delivery']; fenceId: string; settleSources?: () => Promise<void> }>()
  function stopTeamRecovery(id:string){
    const state=creating.get(id)?.teamRecovery;if(!state||!state.pending&&!state.stopped)return false
    if(!state.stopped){state.stopped=true;state.pending=false;state.gate.reject(new Error('agent aborted'))}
    if(!state.stop){const flight=Promise.resolve().then(()=>Reflect.apply(state.close,state.port,[]));state.stop=flight;void flight.catch(error=>{if(state.stop===flight)state.stop=undefined;d.warn('[i-harness] Team recovery close requires cleanup: '+String(error))})}return true
  }
  async function retryTeamRecovery(id:string):Promise<boolean>{
    const row=creating.get(id),state=row?.teamRecovery;if(!row||!state?.pending)return false
    if(state.stopped||closed||closing.has(id))throw Error('Original Team recovery retired')
    if(state.retry){await state.retry;return true}
    if(!isOriginalTeamRecoveryPort(state.port,state.domain,state.handle)||Object.getOwnPropertyDescriptor(state.port,'resume')?.value!==state.resume)throw TypeError('Original Team recovery changed')
    const flight=(async()=>{state.domain.assertCurrent();await Reflect.apply(state.resume,state.port,[]);state.domain.assertCurrent();if(state.stopped||creating.get(id)!==row||row.teamRecovery!==state)throw Error('Original Team recovery retired');state.pending=false;state.gate.resolve()})()
    state.retry=flight;try{await flight}finally{if(state.retry===flight)state.retry=undefined}return true
  }
  function requestDeliveryStop(id: string) {
    const recipient=managedRecipients.get(id)
    if(recipient){if(managedStopReceipts.has(id))return;const request=recipient.requestClose('user-stop'),workflow=managedWorkflowOwners.get(id),task=managedTaskOwners.get(id),prepub=managedPrepubSettlers.get(id);managedStopReceipts.set(id,{recipient,fenceId:request.fenceId,...workflow||task||prepub?{settleSources:async()=>{if(prepub)await prepub();else{await workflow?.journal();await task?.journal()}}}:{}});void request.settled.catch(error=>d.warn('[i-harness] private delivery Stop requires reconciliation: '+String(error)));return}
    const assembly = liveAssembly(id)
    if (!assembly) return
    const delivery = receivedInputsFor(assembly.factOwner, id).delivery
    const request = delivery.requestClose('user-stop')
    deliveryStops.set(id, { delivery, fenceId: request.fenceId, settleSources: assembly.settleParentDeliveryJournalDebt?.bind(assembly) })
    void request.settled.catch(error => d.warn(`[i-harness] delivery Stop requires reconciliation: ${String(error)}`))
  }
  async function awaitDeliveryStop(id: string) {
    const team=creating.get(id)?.teamRecovery;if(team?.stopped&&!team.stop)stopTeamRecovery(id)
    await creating.get(id)?.teamRecovery?.stop
    await managedCodeStops.get(id)?.flight
    const pending=managedStopReceipts.get(id)
    if(pending){await pending.settleSources?.();return pending.recipient.closeReceipt(pending.fenceId)}
    const request = deliveryStops.get(id)
    await request?.settleSources?.()
    return request?.delivery.closeReceipt(request.fenceId)
  }
  function stopNotifications(id: string, attempts?: Map<NotificationStop, Promise<boolean>>): void {
    cancelledParents.add(id)
    for (const controller of notificationControllers.get(id)?.values() ?? []) controller.abort()
    const assembly = assemblies.get(id)
    for (const input of assembly?.inbox.pending() ?? []) {
      if (input.intent !== "system" || !input.inputId.startsWith("parent-notify-")) continue
      const job = stopNotification(id, assembly!, input.inputId)
      attempts?.set(notificationStops.get(assembly!)!.stops.get(input.inputId)!, job)
    }
  }
  function execDeliveryFor(id:string, owner:()=>SessionAssembly|undefined): NonNullable<AssemblyOptions['prepareExecDelivery']> {
    return async input=>{
      const assembly=owner()
      const current=()=>{try{opts.sessionOperation?.assertOpen(id)}catch{return false};return !!assembly&&owner()===assembly&&assemblies.get(id)===assembly&&!closed&&!closing.has(id)}
      if(!current()||input.sessionId!==id||input.view!==assembly!.factOwner.view)throw new ParentNotificationStoppedError()
      opts.sessionOperation?.assertOpen(id)
      const result=await receivedInputsFor(assembly!.factOwner,id).delivery.prepareExecLaunch(input)
      opts.sessionOperation?.assertOpen(id)
      if(!current())throw new ParentNotificationStoppedError()
      return result.kind==='bound'?{...result,isCurrent:()=>current()&&result.isCurrent()}:result
    }
  }
  function codeFinalOutputFor(id: string, owner: () => SessionAssembly | undefined): NonNullable<AssemblyOptions['codeFinalOutputFor']> {
    return (factOwner, sessionId, service, sourceFor) => {
      if (sessionId !== id || factOwner.view.formatVersion !== 14 || !isManagedFactOwner(factOwner.view, factOwner)) return undefined
      const original = createCodeFinalOutputRetention({ service, sourceFor })
      return input => {
        const assembly = owner()
        if (!assembly || assembly.factOwner !== factOwner || assembly.session !== factOwner.view || assemblies.get(id) !== assembly || closed || closing.has(id) || input.sessionId !== id)
          throw new ParentNotificationStoppedError()
        opts.sessionOperation?.assertOpen(id)
        return original(input)
      }
    }
  }
  function parentNotifyFor(id: string, owner: () => SessionAssembly | undefined): NonNullable<AssemblyOptions["parentNotify"]> {
    if (opts.parentNotify) return opts.parentNotify
    return {
      async prepareTaskDelivery(input) {
        const assembly = owner()
        if (input.sessionId !== id || !assembly || assemblies.get(id) !== assembly || closed || closing.has(id)) throw new ParentNotificationStoppedError()
        opts.sessionOperation?.assertOpen(id)
        const result = await receivedInputsFor(assembly.factOwner, id).delivery.prepareLaunch(input.namespace, input.taskId, input.callSeq)
        if (assemblies.get(id) !== assembly || owner() !== assembly || closed || closing.has(id)) throw new ParentNotificationStoppedError()
        return result
      },
      async admitTaskDelivery(input) {
        const assembly = owner()
        if (input.sessionId !== id || !assembly || assemblies.get(id) !== assembly || closed || closing.has(id)) throw new ParentNotificationStoppedError()
        opts.sessionOperation?.assertOpen(id)
        const result = await receivedInputsFor(assembly.factOwner, id).delivery.admit(input.evidence, input)
        if (assemblies.get(id) !== assembly || owner() !== assembly || closed || closing.has(id)) throw new ParentNotificationStoppedError()
        deliveryDrains.get(id)?.signal()
        return result
      },
      admit(input) {
        const previousAdmission = notificationAdmissions.get(id) ?? Promise.resolve()
        const admission = async () => previousAdmission.catch(() => undefined).then(async () => {
          const assembly = assemblies.get(id)
          if (closed || closing.has(id) || cancelledParents.has(id)) throw new ParentNotificationStoppedError()
          if (input.sessionId !== id || !assembly || assembly !== owner()) throw new Error("parent notification admission unavailable")
          const inputId = `parent-notify-${createHash("sha256").update(input.text).update(input.description).digest("hex")}`
          if (!assembly.session.events.some((event) => event.type === "agent/input/admitted" && event.inputId === inputId)) {
            await assembly.inbox.admit({ inputId, text: input.text, delivery: "steer", intent: "system", provenance: { kind: input.display && ["task", "team-message", "team-result"].includes(input.display.kind) ? "child-report" : "plugin", authority: "observation", scope: "turn", producer: "session.notification" }, synthetic: { description: input.description, scope: "turn", ...(input.display !== undefined ? { display: input.display } : {}) } })
          }
          if (closed || closing.has(id) || cancelledParents.has(id)) {
            await stopNotification(id, assembly, inputId)
            throw new ParentNotificationStoppedError()
          }
          let inputs = notificationInputs.get(id)
          if (!inputs) { inputs = new Set(); notificationInputs.set(id, inputs) }
          inputs.add(inputId)
        })
        const job = opts.sessionOperation ? opts.sessionOperation.run(id, admission) : admission()
        notificationAdmissions.set(id, job)
        void job.finally(() => { if (notificationAdmissions.get(id) === job) notificationAdmissions.delete(id) }).catch(() => undefined)
        return job
      },
      wake(sessionId) {
        if (sessionId !== id || closed || closing.has(id)) return
        try { opts.sessionOperation?.assertOpen(id) } catch { return }
        const assembly = assemblies.get(id)
        if (!assembly || assembly !== owner()) return
        deliveryDrains.get(id)?.signal()
        if (cancelledParents.has(id)) return
        let controllers = notificationControllers.get(id)
        if (!controllers) { controllers = new Map(); notificationControllers.set(id, controllers) }
        for (const inputId of notificationInputs.get(id) ?? []) {
          const input = assembly.inbox.pending().find((row) => row.inputId === inputId)
          if (!input || controllers.has(inputId)) continue
          const controller = new AbortController()
          controllers.set(inputId, controller)
          void submit(id, input.text, controller.signal, { admittedInputId: inputId }).catch(() => {
            // The service already emits its execution error; never re-admit.
          }).finally(() => { controllers!.delete(inputId); notificationInputs.get(id)?.delete(inputId) })
        }
      },
    }
  }

  // M49 Task 11: the per-session queue projection state. ONE record per
  // submit (and per adopted lane-only steer), keyed by the STABLE public id
  // generated BEFORE the pacing chain. `wait` = service-front (not yet
  // admitted to the lane); `queued` = admitted and pending; `running` = the
  // lane's current turn; `cancelled` = abort-before-run (hidden, settled by
  // the chain hand-over). Records are removed exactly once on settle/error/
  // cancel/close (the submit cleanup + the queue() finished-purge).
  interface QueueRowRecord {
    id: string
    text: string
    delivery: "queue" | "steer"
    intent: "user" | "system"
    order: number
    controller: AbortController
    state: "wait" | "queued" | "running" | "cancelled"
    scheduled?: boolean
    postTurn?: true
  }
  interface SessionQueueState {
    byId: Map<string, QueueRowRecord>
    /** Next submission-order ordinal (per-session FIFO among service rows). */
    nextOrder: number
    /** Steer-adoption ladder: orders live inside (window, window+1) so they
     * sort after every already-admitted record and before the next one —
     * the adopted steer was admitted DURING the running record's turn. */
    adoptWindow: number
    adoptCount: number
  }
  const queues = new Map<string, SessionQueueState>()

  function queueState(sessionId: string): { running: boolean; queued: number } {
    const items = queue(sessionId)
    return { running: items.some(item => item.state === "running"), queued: items.filter(item => item.state === "queued").length }
  }

  const pendingExecutionNotifications = new Map<string, () => void>()
  function notifyExecutionState(sessionId: string): void {
    if (!executionListeners.size) { executionRevision++; return }
    let state: SessionExecutionState
    try { state = Object.freeze({ sessionId, ...queueState(sessionId), revision: ++executionRevision }) }
    catch {
      const runtime=managedRuntimes.get(sessionId)
      if (runtime && !closed && !closing.has(sessionId) && !pendingExecutionNotifications.has(sessionId)) {
        try {
          const off=subscribeManagedExecutionReadiness(runtime.domain,()=>{if(pendingExecutionNotifications.get(sessionId)!==off)return;pendingExecutionNotifications.delete(sessionId);off();notifyExecutionState(sessionId)},(error,terminal)=>{if(pendingExecutionNotifications.get(sessionId)!==off)return;if(terminal){pendingExecutionNotifications.delete(sessionId);off()}try{d.warn('[i-harness] execution-state observation unavailable: '+String(error))}catch{}})
          pendingExecutionNotifications.set(sessionId,off)
        } catch { try { d.warn('[i-harness] execution-state observation unavailable') } catch {} }
      }
      return
    }
    for (const listener of [...executionListeners]) {
      try { listener(state) }
      catch { try { d.warn('[i-harness] execution-state listener failed') } catch {} }
    }
  }
  function sessionQueueState(sessionId: string): SessionQueueState {
    let st = queues.get(sessionId)
    if (st === undefined) {
      st = { byId: new Map(), nextOrder: 1, adoptWindow: 0, adoptCount: 0 }
      queues.set(sessionId, st)
    }
    return st
  }

  /** Order for a lane-only steer adopted at first sight: strictly inside
   * (admittedWindow, admittedWindow+1), the ladder after the currently
   * running record's order — bounded below by the next unadmitted record. */
  function adoptOrder(st: SessionQueueState, window: number): number {
    if (st.adoptWindow !== window) {
      st.adoptWindow = window
      st.adoptCount = 0
    }
    st.adoptCount += 1
    return window + 1 - Math.pow(0.5, st.adoptCount)
  }

  function bindingFor(sessionId: string): Promise<SessionModelBindingResult> {
    let pending = modelBindings.get(sessionId)
    if (pending === undefined) {
      const resolveBinding = opts.modelBindingFor
      pending = resolveBinding === undefined
        ? Promise.resolve({ status: "unconfigured", reason: "No model configured" })
        : (async () => {
            const meta = opts.loadMeta === undefined ? undefined : await opts.loadMeta(sessionId)
            return resolveBinding(sessionId, meta)
          })()
      modelBindings.set(sessionId, pending)
      const attempt = pending
      // A missing key/default can be repaired while this host stays alive.
      // Keep successful bindings stable; only failed resolution is retryable.
      void attempt.then((result) => {
        if (result.status !== "ready" && modelBindings.get(sessionId) === attempt) modelBindings.delete(sessionId)
      }, () => { if (modelBindings.get(sessionId) === attempt) modelBindings.delete(sessionId) })
    }
    return pending
  }

  async function modelState(sessionId: string): Promise<SessionModelState> {
    if (closed) throw new Error("session service closed")
    const pendingClose = closing.get(sessionId)
    if (pendingClose !== undefined) await pendingClose
    if (closed) throw new Error("session service closed")
    const result = await bindingFor(sessionId)
    if (result.status !== "ready") return result
    return {
      status: "ready",
      providerId: result.binding.providerId,
      modelId: result.binding.modelId,
      label: result.binding.label,
      ...(result.binding.protocol ? { protocol: result.binding.protocol } : {}),
      ...(result.binding.reasoningEffort ? { reasoningEffort: result.binding.reasoningEffort } : {}),
      ...(result.binding.reasoningEfforts ? { reasoningEfforts: [...result.binding.reasoningEfforts] } : {}),
      ...(result.binding.imageInput ? { imageInput: true } : {}),
    }
  }

  function liveContextState(sessionId: string): SessionContextState | undefined {
    const assembly = assemblies.get(sessionId)
    if (assembly) return contextStateFromBudget(assembly.agent.contextBudget?.() ?? { kind: "unavailable", reason: "Live Agent context budget reader is unavailable" })
    for (const parent of assemblies.values()) {
      const read = parent.liveChildBudget?.(sessionId)
      if (read) return contextStateFromBudget(read)
    }
    return undefined
  }
  const contextState = createContextStateReader<SessionMeta>({
    assertOpen() { if (closed) throw new Error("session service closed") },
    live: liveContextState,
    meta: async sessionId => await opts.loadMeta?.(sessionId) ?? (opts.coordinator ? (await opts.coordinator.profile(sessionId)).meta : undefined),
    snapshot: async sessionId => opts.coordinator?.snapshot ? (await opts.coordinator.snapshot(sessionId)).session : opts.sessionFor === undefined ? opts.session : undefined,
    ...(opts.modelMetadataFor ? { metadata: opts.modelMetadataFor } : {}),
  })

  function rebindModel(sessionId: string, binding: ReadyModelBinding): boolean {
    if (closed) throw new Error("session service closed")
    if (chains.has(sessionId) || creating.has(sessionId) && !managedRuntimes.has(sessionId) || closing.has(sessionId)) throw new Error("session is busy")
    if (failedClose.has(sessionId)) throw new Error("Session process cleanup incomplete")
    const managed = managedRuntimes.get(sessionId)
    const live = assemblies.get(sessionId)
    if (live?.tasks().some(task => task.group !== "job" && ["queued", "running", "waiting"].includes(task.status))) throw new Error("session has active agent tasks")
    if (live !== undefined) {
      if (!live.setModelBinding) throw new Error("assembly does not support atomic model binding")
      live.setModelBinding(binding, opts.compact)
    }
    managed?.setModelBinding(binding, opts.managedRuntime?.compact ?? opts.compact)
    // Publish only after the live assembly accepted the complete binding.
    modelBindings.set(sessionId, Promise.resolve({ status: "ready", binding }))
    const assembly = assemblies.get(sessionId)
    if (assembly === undefined) return managed !== undefined
    assembly.modelLabel = binding.label
    return true
  }

  function assertWritableOpen(sessionId: string): void {
    if (closed) throw new Error("session service closed")
    if (closing.has(sessionId)) throw new Error(`session closing: ${sessionId}`)
    if (failedClose.has(sessionId)) throw new Error("Session process cleanup incomplete; retry close before admission")
    opts.sessionOperation?.assertOpen(sessionId)
  }

  function writableSessionFor(sessionId: string, fallback?: (sessionId: string) => Promise<Session | undefined>): Promise<Session | undefined> {
    return opts.sessionOperation ? opts.sessionOperation.run(sessionId, () => writableSessionUnfenced(sessionId, fallback)) : writableSessionUnfenced(sessionId, fallback)
  }
  async function writableSessionUnfenced(sessionId: string, fallback?: (sessionId: string) => Promise<Session | undefined>): Promise<Session | undefined> {
    assertWritableOpen(sessionId)
    selectComplete(sessionId)
    const owned = assemblies.get(sessionId)?.session ?? mountingAssemblies.get(sessionId)?.session ?? writableSessions.get(sessionId)
    if (owned) return owned
    let pending = loadingWriters.get(sessionId)
    if (!pending) {
      pending = (async () => {
        const session = opts.sessionFor ? await opts.sessionFor(sessionId) : opts.session ?? await fallback?.(sessionId)
        // Close owns the pending load. Its late completion cannot install a
        // writer in the next lifecycle or publish an execution assembly.
        assertWritableOpen(sessionId)
        const attachment = await openExecutorDocument({ ...(opts.coordinator ? { coordinator: opts.coordinator, sessionId } : {}), ...(session ? { session } : {}) })
        writableSessions.set(sessionId, attachment.session)
        inputInboxes.set(sessionId, attachment.inbox)
        return attachment.session
      })().finally(() => { if (loadingWriters.get(sessionId) === pending) loadingWriters.delete(sessionId) })
      loadingWriters.set(sessionId, pending)
    }
    return pending
  }

  async function receivedInputFor(sessionId: string): Promise<Pick<AsyncInbox, 'pending' | 'admit' | 'cancel'>> {
    const managed=await managedInputFor(sessionId)
    if(managed)return managed.inbox
    await writableSessionFor(sessionId)
    assertWritableOpen(sessionId)
    const inbox = assemblies.get(sessionId)?.inbox ?? mountingAssemblies.get(sessionId)?.inbox ?? inputInboxes.get(sessionId)
    if (!inbox) throw Object.assign(new Error('Trusted received-input owner is unavailable'), { code: 'FACT_OWNER_UNSUPPORTED' })
    return { pending: () => inbox.pending(), admit: (input, signal) => inbox.admit(input, signal), cancel: (id, reason) => inbox.cancel(id, reason) }
  }

  async function managedInputFor(sessionId:string,requirements?:{completePreparation?:boolean;supplementalContext?:boolean}){
    assertWritableOpen(sessionId)
    if(!requirements?.completePreparation)await prepareFirstParty(sessionId)
    if(requirements?.completePreparation){selectComplete(sessionId);return undefined}
    if(privateEntries.has(sessionId)&&!managedCompatible(sessionId))throw Error('Private entry cannot switch to Session-shaped compatibility')
    if(!managedCompatible(sessionId)){selectComplete(sessionId);return undefined}
    if(!privateCache)throw Error('Managed runtime requires original coordinator')
    validateFirstParty(sessionId);privateEntries.add(sessionId)
    const entry=await privateCache.get(sessionId);assertWritableOpen(sessionId);validateFirstParty(sessionId)
    return Object.freeze({inbox:entry.inputs.inbox,observe(){assertWritableOpen(sessionId);return entry.execution.observe()}})
  }

  function getOrCreate(sessionId: string): Promise<SessionAssembly> {
    return opts.sessionOperation ? opts.sessionOperation.run(sessionId, () => getOrCreateUnfenced(sessionId)) : getOrCreateUnfenced(sessionId)
  }
  async function getOrCreateUnfenced(sessionId: string): Promise<SessionAssembly> {
    if(privateEntries.has(sessionId)||managedRuntimes.has(sessionId))throw Error('Private runtime requires explicit complete compatibility adapter')
    selectComplete(sessionId)
    if (closed) throw new Error("session service closed")
    if (failedClose.has(sessionId)) throw new Error("Session process cleanup incomplete; retry close before admission")
    const pendingClose = closing.get(sessionId)
    if (pendingClose !== undefined) await pendingClose
    if (closed) throw new Error("session service closed")
    const existing = assemblies.get(sessionId)
    if (existing !== undefined) return existing
    let pending = creating.get(sessionId)
    if (pending?.failed) throw new Error('Session process cleanup incomplete; retry close before admission')
    if (pending === undefined) {
      // Publish the owner before build starts, including synchronous retention
      // during the original constructor. Never replace this row after failure.
      const work = Promise.withResolvers<SessionAssembly>()
      const row: CreatingAssembly = { work: work.promise, publicWork:work.promise, failed: false, residentActivation: createResidentActivation(() =>
        !!row.assembly && !closed && !closing.has(sessionId) && !failedClose.has(sessionId)
        && assemblies.get(sessionId) === row.assembly && !retiredSurfaces.has(row.assembly) && row.assembly.executionSurfaceState?.() !== 'retired') }
      pending = row
      creating.set(sessionId, row)
      void (async () => {
        const extensions = await opts.extensionsFor?.(sessionId)
        const projectContext = opts.projectContextFor ? await opts.projectContextFor(sessionId) : opts.projectContext
        const executionAuthority = opts.executionAuthorityFor ? await opts.executionAuthorityFor(sessionId) : opts.executionAuthority
        let assembly: SessionAssembly
        const executionCallerAvailable = () => !closed && !closing.has(sessionId) && !failedClose.has(sessionId)
          && (liveAssembly(sessionId) === assembly || mountingAssemblies.get(sessionId) === assembly)
        let sandboxAtBuild: SandboxMode | undefined
        if (opts.modelBindingFor !== undefined) {
          // Durable writable acquisition (including the format barrier) precedes
          // executable model resolution; a held/refused upgrade has no model side effect.
          const resolvedSession = await writableSessionFor(sessionId)
          const result = await bindingFor(sessionId)
          if (result.status !== "ready") throw new ModelUnavailableError(result.reason)
          const binding = result.binding
          // The BINDING is authoritative here: `modelBindingFor` exists so that
          // state and construction share one resolution, so its window decides
          // and its ABSENCE disables compaction. A window the host put in the
          // config must not override a binding that deliberately has none — the
          // service test for this supplies `contextWindow: 1`, which would leave
          // the engine permanently over threshold.
          //
          // What changed is the SILENCE, not the rule: this used to drop the
          // request without a word. It now says so, because the caller asked for
          // compaction and will otherwise assume it is running.
          const compact = binding.contextWindow !== undefined ? opts.compact : undefined
          if (opts.compact !== undefined && binding.contextWindow === undefined) {
            d.warn(
              "[i-harness] the resolved model binding carries no contextWindow, so auto-compaction is DISABLED for this session despite the requested config. " +
                "The binding is authoritative — a window from the config is not used to override its absence.",
            )
          }
          sandboxAtBuild = currentSandbox
          assembly = await createSessionAssembly({
            prepareHumanInput: opts.transformPrompt ? text => opts.transformPrompt!(assembly, text) : undefined,
            ...opts,
            instructionEnvironment: instructions(),
            sandbox: sandboxAtBuild,
            ...extensions?.options,
            projectContext,
            executionAuthority,
            executionCallerAvailable,
            residentActivation: row.residentActivation,
            retainConstructionCleanup: cleanup => { row.cleanup = cleanup },
            windowsSandboxBackend: opts.windowsSandboxBackendFor?.() ?? opts.windowsSandboxBackend,
            wslExecution: await (opts.wslExecutionFor?.() ?? opts.wslExecution),
            webSearchMode: opts.webSearchModeFor?.() ?? opts.webSearchMode,
            parentNotify: parentNotifyFor(sessionId, () => assembly),
            prepareExecDelivery: execDeliveryFor(sessionId, () => assembly),
            codeFinalOutputFor: codeFinalOutputFor(sessionId, () => assembly),
            sessionId,
            session: resolvedSession,
            model: binding.model,
            modelLabel: binding.label,
            contextWindow: binding.contextWindow,
            maxOutputTokens: binding.maxOutputTokens,
            budgetBinding: binding.budgetBinding,
            contextMetadata: binding.contextMetadata,
            reasoningEffort: binding.reasoningEffort,
            compact,
          })
        } else {
          // Legacy path retained for explicit embedders; production apps use
          // modelBindingFor so state and construction share one resolution.
          const resolvedSession = await writableSessionFor(sessionId)
          const meta = opts.loadMeta === undefined ? undefined : await opts.loadMeta(sessionId)
          const model = opts.modelBuilder === undefined ? undefined : await opts.modelBuilder(sessionId, meta)
          // M31 T3: per-session window (meta-aware) — a defined contextWindowFor
          // decides even when it resolves to undefined (fail-closed).
          const contextWindow = opts.contextWindowFor === undefined
            ? opts.contextWindow
            : opts.contextWindowFor(sessionId, meta)
          // M32 T3: per-session effort (same meta-driven pattern as the window).
          // A DEFINED resolver always wins — even when it resolves to undefined
          // (the explicit spread below overrides the `...opts` static value; the
          // assembly treats undefined as "never set").
          const reasoningEffort = opts.reasoningEffortFor === undefined
            ? opts.reasoningEffort
            : opts.reasoningEffortFor(sessionId, meta)
          sandboxAtBuild = currentSandbox
          assembly = await createSessionAssembly({
            prepareHumanInput: opts.transformPrompt ? text => opts.transformPrompt!(assembly, text) : undefined,
            ...opts,
            instructionEnvironment: instructions(),
            sandbox: sandboxAtBuild,
            ...extensions?.options,
            projectContext,
            executionAuthority,
            executionCallerAvailable,
            residentActivation: row.residentActivation,
            retainConstructionCleanup: cleanup => { row.cleanup = cleanup },
            windowsSandboxBackend: opts.windowsSandboxBackendFor?.() ?? opts.windowsSandboxBackend,
            wslExecution: await (opts.wslExecutionFor?.() ?? opts.wslExecution),
            webSearchMode: opts.webSearchModeFor?.() ?? opts.webSearchMode,
            parentNotify: parentNotifyFor(sessionId, () => assembly),
            prepareExecDelivery: execDeliveryFor(sessionId, () => assembly),
            codeFinalOutputFor: codeFinalOutputFor(sessionId, () => assembly),
            sessionId,
            session: resolvedSession,
            ...(model !== undefined ? { model } : {}),
            ...(opts.contextWindowFor !== undefined ? { contextWindow } : {}),
            ...(opts.reasoningEffortFor !== undefined ? { reasoningEffort } : {}),
          })
        }
        row.assembly = assembly
        if (currentSandbox !== sandboxAtBuild && currentSandbox !== undefined) await assembly.recordSandboxMode(currentSandbox)
        writableSessions.set(sessionId, assembly.session)
        mountingAssemblies.set(sessionId, assembly)
        row.cleanup = undefined // ownership transfers to this real assembly
        surfaceSubscriptions.set(assembly, assembly.onExecutionSurfaceChanged?.(() => {
          if (assembly.executionSurfaceState?.() === 'retired') retireSurface(sessionId, assembly)
        }) ?? (() => {}))
        if (extensions?.mount) {
          try {
            const cleanup = await extensions.mount(assembly)
            if (cleanup) {
              extensionCleanups.set(sessionId, cleanup)
            }
          } catch (error) {
            revokeSession(sessionId)
            try { await disposeOwnedAssembly(assembly) }
            catch (cleanup) { throw new AggregateError([error, cleanup], "Assembly extension mount and cleanup failed", { cause: error }) }
            mountingAssemblies.delete(sessionId)
            removeSurface(sessionId, assembly)
            throw error
          }
        }
        if (closed || closing.has(sessionId)) {
          await disposeOwnedAssembly(assembly)
          mountingAssemblies.delete(sessionId)
          removeSurface(sessionId, assembly)
          throw new Error(closed ? "session service closed" : `session closing: ${sessionId}`)
        }
        if (opts.extensionsFor) {
          const dispose = assembly.dispose.bind(assembly)
          let disposing: Promise<void> | undefined
          assembly.dispose = () => {
            assembly.revokeNewWork()
            if (disposing) return disposing
            const pending = (async () => {
              await extensionRefreshes.get(sessionId)?.catch(() => undefined)
              const failures: unknown[] = []
              const current = extensionCleanups.get(sessionId)
              try { await current?.(); extensionCleanups.delete(sessionId) } catch (error) { failures.push(error) }
              try { await dispose() } catch (error) { failures.push(error) }
              if (failures.length) throw new AggregateError(failures, "Assembly extension/process cleanup incomplete")
            })()
            disposing = pending
            void pending.then(() => { disposing = undefined }, () => { disposing = undefined })
            return pending
          }
        }
        // No await between this reconciliation and publication. A settings
        // change during an asynchronous extension mount must not miss an
        // assembly that was not yet present in the live map.
        assemblies.set(sessionId, assembly)
        mountingAssemblies.delete(sessionId)
        assembly.ctx.on("agent/pre-step", async () => { await extensionRefreshes.get(sessionId)?.catch(() => undefined) })
        // The A-region serial lane over this assembly (tiers; send on submit).
        lanes.set(sessionId, createSessionExecutor({
          session: assembly.session,
          agent: assembly.agent,
          inbox: assembly.inbox,
        }))
        const published = assembly
        const delivery = receivedInputsFor(published.factOwner, sessionId).delivery
        const deliveryDrain = createDeliveryDrain({
          current: () => !closed && !closing.has(sessionId) && !failedClose.has(sessionId) && assemblies.get(sessionId) === published && (!published.managedDocument || managedExecutionStatus(published.managedDocument) !== 'retired'),
          reconcile: async () => {
            const failures: unknown[] = []
            try { await published.drainParentNotifications?.(true) } catch (error) { failures.push(error) }
            try { await delivery.settle() } catch (error) { failures.push(error) }
            try { await delivery.reconcileExecCandidates() } catch (error) { failures.push(error) }
            try { await delivery.reconcileCodeCandidates() } catch (error) { failures.push(error) }
            if (failures.length) {
              for (const error of failures) d.warn(`[i-harness] original delivery settlement: ${String(error)}`)
              // Select a nominal actual-owner classification directly, never
              // infer retry authority by unwrapping arbitrary aggregates.
              throw failures.find(isRetryableDeliveryError) ?? failures[0]
            }
          },
          pending: () => published.inbox.pending().filter(input => ['session.delivery.subagent', 'session.delivery.exec', 'session.delivery.code'].includes(input.provenance?.producer ?? '')
            && isBoundDeliveryInput(published.session, input.inputId) && isDeliveryExecutable(published.session, input.inputId)).map(input => input.inputId),
          schedule(inputId, settled) {
            if (assemblies.get(sessionId) !== published || closed || closing.has(sessionId) || !published.inbox.isPending(inputId)) return false
            try { published.managedDocument?.assertReady() } catch { return false }
            const input = published.inbox.pending().find(input => input.inputId === inputId)
            if (!input) return false
            if (queues.get(sessionId)?.byId.get(inputId)?.scheduled || lanes.get(sessionId)?.currentInput()?.inputId === inputId) return false
            // Register on existing service pacing; mounting must never await
            // the turn whose preparation may join this creation promise.
            void submit(sessionId, input.text, new AbortController().signal, { admittedInputId: inputId }, published).then(settled, settled)
            return true
          },
          report: error => d.warn(`[i-harness] delivery reconciliation failed: ${String(error)}`),
        })
        deliveryDrains.set(sessionId, deliveryDrain)
        executionSubscriptions.get(sessionId)?.()
        executionSubscriptions.set(sessionId, subscribe(assembly.session, event => {
          if (event.type === "agent/input/admitted" || event.type === "agent/input/promoted" || event.type === "agent/input/cancelled") {
            notifyExecutionState(sessionId)
          }
          if (event.type === 'agent/delivery-received' || event.type === 'agent/delivery-generation' || event.type === 'agent/delivery-source' || event.type === 'subagent/end' || event.type === 'exec/end' || event.type === 'code/end' || event.type === 'agent/delivery-handoff' || event.type === 'agent/input/promoted' || event.type === 'agent/input/cancelled') deliveryDrain.signal()
        }))
        // Hooks fire ONCE per assembly, after registration, inside the shared
        // pending — concurrent racers never double-attach (ApprovalMuxBridge
        // registers its answerer per ctx; a double attach would register twice).
        if (surfaceKind(sessionId, assembly) === 'retiring') {
          assembly.revokeNewWork(); retireSurface(sessionId, assembly)
        } else notifySurface({ sessionId, assembly, kind: 'published' })
        for (const hook of [...hooks,...hostAssemblyHooks]) hook(assembly)
        if (creating.get(sessionId) === row) row.residentActivation.activate()
        // Recovery admission needs the exact published parent and its lane.
        // Waking schedules through submit without awaiting that turn here.
        try { await assembly.drainParentNotifications?.() }
        catch (error) { d.warn(`[i-harness] parent notification recovery failed: ${error instanceof Error ? error.message : String(error)}`) }
        // Initial source admission may have failed before emitting any fact.
        // Activate the published retry owner even when that attempt rejected.
        await deliveryDrain.reconcile()
        return assembly
      })().catch(error => {
        row.residentActivation.retire()
        // Failed setup cleanup still owns its mounted resources. A retry must
        // acknowledge that close before another assembly can replace them.
        if (mountingAssemblies.has(sessionId)) failedClose.add(sessionId)
        row.failed = true
        if (row.cleanup) failedClose.add(sessionId)
        throw error
      }).finally(() => { if (!row.cleanup && creating.get(sessionId) === row) creating.delete(sessionId) }).then(work.resolve, work.reject)
    }
    if(!pending.publicWork)throw Error('Private runtime cannot publish a public assembly')
    return pending.publicWork
  }

  function getManagedRuntime(sessionId:string):Promise<ManagedRuntime>{
    assertWritableOpen(sessionId)
    const existing=managedRuntimes.get(sessionId);if(existing)return Promise.resolve(existing)
    const prior=creating.get(sessionId)
    if(prior){if(prior.failed)return Promise.reject(Error('Session process cleanup incomplete'));if(!prior.managedWork)return Promise.reject(Error('Complete compatibility construction already selected'));return prior.managedWork}
    if(!managedCompatible(sessionId)||!privateCache||!opts.managedRuntime)return Promise.reject(Error('Managed runtime configuration unavailable'))
    try{validateFirstParty(sessionId)}catch(error){return Promise.reject(error)}
    const work=Promise.withResolvers<ManagedRuntime>()
    const row:CreatingAssembly={work:work.promise,managedWork:work.promise,failed:false,residentActivation:createResidentActivation(()=>false)}
    creating.set(sessionId,row);privateEntries.add(sessionId)
    let runtime:ManagedRuntime|undefined
    const mounted=new Set<()=>void|Promise<void>>()
    const title=opts.managedRuntime.ownedTitle?.enabled?createOwnedPostTurnLifetime():undefined
    if(title)mounted.add(()=>title.close())
    let retired=false,recipient:ReturnType<ReturnType<typeof receivedExecutionInputsFor>['execDelivery']>|undefined,privateDrain:ReturnType<typeof createDeliveryDrain>|undefined,unsubscribe:(()=>void)|undefined,unsubscribeReadiness:(()=>void)|undefined
    row.cleanup=async()=>{retired=true;retireManaged(sessionId);privateDrain?.retire();unsubscribe?.();unsubscribeReadiness?.();await privateDrain?.join();await runtime?.close();await drainManagedIngress(sessionId);for(const cleanup of [...mounted].reverse()){await cleanup();mounted.delete(cleanup)}await recipient?.settle();recipient?.revoke();await privateCache.close(sessionId);privateCache.releaseClosed(sessionId);managedRuntimes.delete(sessionId);managedTitles.delete(sessionId);managedRecipients.delete(sessionId);managedPrepubSettlers.delete(sessionId);managedStopReceipts.delete(sessionId);managedCodeMounts.delete(sessionId);managedCodeStops.delete(sessionId);managedTaskOwners.delete(sessionId);managedWorkflowOwners.delete(sessionId);managedRewinds.delete(sessionId);removeManaged(sessionId);privateEntries.delete(sessionId)}
    void(async()=>{
      const entry=await privateCache.get(sessionId);assertWritableOpen(sessionId)
      const context=createContext()
      let mounting=true
      try{await opts.managedRuntime!.mount?.(context,cleanup=>{if(!mounting)throw Error('Original construction retention expired');if(typeof cleanup!=='function')throw TypeError('Original mount cleanup required');mounted.add(cleanup)})}finally{mounting=false}
      assertWritableOpen(sessionId)
      // Reject unmarked Session callbacks/legacy runtime before resolving a model.
      captureExecutionHookChannel(context).capture()
      let resolution:Promise<{model:import('@i-harness/llm-seam').ModelClient;contextWindow?:number;reasoningEffort?:import('@i-harness/llm-seam').ReasoningEffort;maxOutputTokens?:number;budgetBinding?:import('@i-harness/llm-seam').ModelBudgetBinding;contextMetadata?:import('@i-harness/core-session').ContextBindingMetadata}>|undefined
      const resolveModel=()=>resolution??=(async()=>{
       const binding=opts.modelBindingFor?await bindingFor(sessionId):undefined
       const meta=!binding&&opts.loadMeta?await opts.loadMeta(sessionId):undefined
       const model=binding?.status==='ready'?binding.binding.model:binding?undefined:opts.modelBuilder?await opts.modelBuilder(sessionId,meta):opts.model
       const contextWindow=binding?.status==='ready'?binding.binding.contextWindow:opts.contextWindowFor===undefined?opts.contextWindow:opts.contextWindowFor(sessionId,meta)
       const reasoningEffort=binding?.status==='ready'?binding.binding.reasoningEffort:opts.reasoningEffortFor===undefined?opts.reasoningEffort:opts.reasoningEffortFor(sessionId,meta)
       assertWritableOpen(sessionId)
       if(!model)throw new ModelUnavailableError(binding&&binding.status!=='ready'?binding.reason:'Managed runtime requires original resolved model')
       return {model,contextWindow,reasoningEffort,maxOutputTokens:binding?.status==='ready'?binding.binding.maxOutputTokens:opts.maxOutputTokens,budgetBinding:binding?.status==='ready'?binding.binding.budgetBinding:opts.budgetBinding,contextMetadata:binding?.status==='ready'?binding.binding.contextMetadata:opts.contextMetadata}
      })()
      let instructionBinding:import('./managed-assembly.ts').OwnedInstructionBinding|undefined
      if(opts.managedRuntime!.acquireInstructions){let acquiring=true;try{instructionBinding=await opts.managedRuntime!.acquireInstructions(sessionId,entry.execution,cleanup=>{if(!acquiring||retired)throw Error('Original instruction retention expired');assertWritableOpen(sessionId);if(typeof cleanup!=='function')throw TypeError('Original instruction cleanup required');mounted.add(cleanup)})}finally{acquiring=false}assertWritableOpen(sessionId)}
      const rawCodeConfig=opts.managedRuntime!.ownedCode?(opts.managedRuntime!.ownedCode.configFor?.(sessionId)??opts.managedRuntime!.ownedCode.config):undefined
      const codeConfig=rawCodeConfig===undefined?undefined:captureCodeModeConfig(rawCodeConfig)
      if(opts.managedRuntime!.ownedCode&&!codeConfig)throw Error('Original Code configuration required')
      let rewindMount:OwnedRewindHandle|undefined
      let published=false
      let workflowMount:ReturnType<typeof mountOwnedWorkflow>|undefined
      let taskNotify:ParentInputAdmission|undefined
      let taskMount:RegisterSubagentResult|undefined,taskLifecycle:TaskLifecycle|undefined,initialTaskModel:import('@i-harness/llm-seam').ModelClient|undefined,initialBinding:import('./managed-assembly.ts').ManagedExecutionModelBinding|undefined
      let shellMount:import('./owned-shell.ts').OwnedShellMount|undefined
      let codeMount:import('@i-harness/code-mode').CodeModeMount|undefined
      let shellExecution:import('@i-harness/exec').ExecExecutionHost|undefined
      if(opts.managedRuntime!.ownedShell?.acquireExecution){let acquiring=true;try{shellExecution=await opts.managedRuntime!.ownedShell.acquireExecution(sessionId,cleanup=>{if(!acquiring||retired)throw Error('Original execution retention expired');assertWritableOpen(sessionId);if(typeof cleanup!=='function')throw TypeError('Original execution cleanup required');mounted.add(cleanup)},entry.execution)}finally{acquiring=false}assertWritableOpen(sessionId);if(shellExecution.defaultOwner?.sessionId!==sessionId)throw TypeError('Original Shell execution owner required')}
      let shellOutput:import('./owned-shell.ts').OwnedShellOutput|undefined
      if(opts.managedRuntime!.ownedShell){let acquiring=true;try{shellOutput=await opts.managedRuntime!.ownedShell.acquireOutput(sessionId,cleanup=>{if(!acquiring||retired)throw Error('Original output retention expired');assertWritableOpen(sessionId);if(typeof cleanup!=='function')throw TypeError('Original output cleanup required');mounted.add(cleanup)})}finally{acquiring=false}assertWritableOpen(sessionId)}
      if(opts.managedRuntime!.ownedCode&&!shellOutput){let acquiring=true;try{shellOutput=await opts.managedRuntime!.ownedCode.acquireOutput(sessionId,cleanup=>{if(!acquiring||retired)throw Error('Original output retention expired');assertWritableOpen(sessionId);if(typeof cleanup!=='function')throw TypeError('Original output cleanup required');mounted.add(cleanup)})}finally{acquiring=false}assertWritableOpen(sessionId)}
      const filesystemPolicy=shellExecution?originalFilesystemPolicyFor(shellExecution,entry.execution):undefined
      if(opts.managedRuntime!.requireFilesystemPolicy&&!filesystemPolicy)throw TypeError('Original filesystem policy required')
      const common={...opts.managedRuntime!,...filesystemPolicy?{filesystemPolicy}:{},context,execution:entry.execution,workspace:opts.workspace,...instructionBinding?{instructionBinding}:{},...(shellOutput?{resultRetention:createToolResultRetention(shellOutput.service,shellOutput.sourceFor)}:{}),retainConstructionCleanup:(cleanup:()=>Promise<void>)=>{mounted.add(cleanup)},scheduleWake:(inputId:string,text:string)=>{void submit(sessionId,text,new AbortController().signal,{admittedInputId:inputId}).catch(error=>d.warn('[i-harness] scheduled input failed: '+String(error)))},
        modelActionTimeoutMs:opts.modelActionTimeoutMs,modelActionMaxAttempts:opts.modelActionMaxAttempts,maxParallelToolCalls:opts.maxParallelToolCalls,telemetry:opts.telemetry,
        ...(opts.passiveGeneration?{passiveGeneration:opts.passiveGeneration}:{})}
      if(opts.managedRuntime!.mountRegistry||opts.managedRuntime!.ownedShell||opts.managedRuntime!.ownedCode||opts.managedRuntime!.ownedTask||opts.managedRuntime!.ownedWorkflow||opts.managedRuntime!.ownedRewind||opts.managedRuntime!.mountDefaultSurface){
       runtime=await createManagedExecutionRuntimeWithRegistry({...common,...opts.managedRuntime!.ownedRewind?{async prepareFilesystem(original:import('./managed-assembly.ts').ManagedRegistryConstruction){const config=opts.managedRuntime!.ownedRewind!;rewindMount=await mountOwnedRewind({domain:original.domain,root:config.root,workspace:config.workspace,assertCurrent:original.assertCurrent,retain:original.retain});original.assertCurrent();if(!rewindMount)return undefined;const recorder=rewindMount.recorder,take=recorder.take;return {take(path:string,before:Uint8Array|null){if(recorder.take!==take)throw Error('Original Rewind recorder changed');const result=Reflect.apply(take,recorder,[path,before]);if(recorder.take!==take)throw Error('Original Rewind recorder changed');return result}}}}:{},async configureRegistry(original){const registrySurface=await opts.managedRuntime!.mountRegistry?.(original);original.assertCurrent();if(opts.managedRuntime!.ownedShell){if(opts.workspace===undefined)throw Error('Original Shell workspace required');shellMount=mountOwnedShell(original,opts.workspace,opts.managedRuntime!.ownedShell,shellOutput!,!!(opts.managedRuntime!.originalFilesystem||opts.managedRuntime!.originalSchedule||opts.managedRuntime!.originalApproval),shellExecution)}if(opts.managedRuntime!.ownedWorkflow){if(!shellMount||!shellOutput||opts.workspace===undefined)throw Error('Original Workflow Shell and output owners required');workflowMount=mountOwnedWorkflow(original,opts.workspace,shellMount,shellOutput)}if(opts.managedRuntime!.ownedTask){
        recipient=receivedExecutionInputsFor(entry.execution).taskDelivery(original.domain)
        const originalRecipient=recipient,current=()=>{if(retired||closed||closing.has(sessionId)||(published?(!runtime||managedRuntimes.get(sessionId)!==runtime):creating.get(sessionId)!==row))throw new ParentNotificationStoppedError();original.domain.assertCurrent();assertWritableOpen(sessionId)}
        managedRecipients.set(sessionId,recipient);managedPrepubSettlers.set(sessionId,async()=>{await workflowMount?.reconcileCapturedHandoffs();await taskLifecycle?.journal()})
        const notify:ParentInputAdmission={taskEvidence(namespace,id){current();return originalRecipient.taskEvidence(namespace,id)},async prepareTaskDelivery(input){current();if(input.sessionId!==sessionId)throw new ParentNotificationStoppedError();const result=await originalRecipient.prepareTaskLaunch(input);current();return result},async admitTaskDelivery(input){current();if(input.sessionId!==sessionId)throw new ParentNotificationStoppedError();const result=await originalRecipient.admitTask(input.evidence,{text:input.text,description:input.description,display:input.display});current();privateDrain?.signal();return result},async admitTeamDelivery(evidence){current();const result=await originalRecipient.admitTeam(evidence);current();if(assertOriginalTeamDeliveryReceipt(evidence,result)==='pending'&&published)privateDrain?.signal();return result},async admit(){throw new ParentNotificationStoppedError('Original Task delivery evidence required')},wake(id){if(id!==sessionId||!published)return;try{current();privateDrain?.signal()}catch{/* Retired original parent cannot be woken. */}}}
        taskNotify=notify
        const taskOptions=await opts.managedRuntime!.ownedTask.options(original,{...shellMount?{shell:shellMount.service}:{},...shellOutput?{output:shellOutput}:{},...codeConfig?{codeConfig}:{}});original.assertCurrent()
        const taskFields=Object.getOwnPropertyDescriptors(taskOptions);for(const field of Object.values(taskFields))if(field.get){const get=field.get;field.get=()=>Reflect.apply(get,taskOptions,[])}
        const taskAdditions={...workflowMount?{workflow:workflowMount.executor}:{},managedParent:{domain:original.domain,execution:original.execution},parentNotify:notify,deferRestoredWork:true,getParentModel:()=>{const model=taskOptions.parentModel??(runtime?runtime.selectedModelBinding().model:initialTaskModel);if(!model)throw Error('Original parent model not bound');return model}}
        taskMount=registerSubagent(original.ctx,original.tools,Object.defineProperties({}, {...taskFields,...Object.getOwnPropertyDescriptors(taskAdditions)}) as Parameters<typeof registerSubagent>[2])
        const mounted=taskMount,dispose=mounted.dispose,drain=mounted.drainParentNotifications,journal=mounted.settleParentDeliveryJournalDebt,activate=mounted.activateRestoredWork,catalogReady=mounted.catalogReady,ready=mounted.ready,project=mounted.projectTasks.bind(mounted),table=mounted.table,jobs=mounted.jobs,tasks=mounted.tasks,entriesMethod=table.entries,getMethod=table.get,listJobsMethod=jobs.listAll,listTasksMethod=tasks.list,tableGet=getMethod.bind(table),kill=jobs.kill.bind(jobs)
        taskLifecycle=Object.freeze({dispose:()=>Reflect.apply(dispose,mounted,[]),drain:()=>Reflect.apply(drain,mounted,[]),journal:()=>Reflect.apply(journal,mounted,[]),activate:()=>Reflect.apply(activate,mounted,[]),ready,projectTasks(){const check=()=>{if(table.entries!==entriesMethod||table.get!==getMethod||jobs.listAll!==listJobsMethod||tasks.list!==listTasksMethod)throw Error('Original Task projection changed')};check();const rows=project();check();return rows},projectionIntegrity(){if(!opts.coordinator)return Promise.reject(Error('Task projection integrity requires the original coordinator'));const coordinator=opts.coordinator;return (async()=>[...await inspectTaskProjection(tasks,coordinator),...await inspectJobRecordProjection(tasks,coordinator)])()},reconcileProjection(){if(!opts.coordinator)return Promise.reject(Error('Task projection integrity requires the original coordinator'));const coordinator=opts.coordinator;return (async()=>[...await reconcileTaskProjection(tasks,coordinator),...await inspectJobRecordProjection(tasks,coordinator)])()},cancelTask(id:string){const entry=tableGet(id);if(entry!==undefined){if(entry.status!=='running')return 'already-finished';entry.controller.abort();return entry.jobId!==undefined?kill(entry.jobId):'cancellation-requested'}return kill(id)}})
        original.retain(taskLifecycle.dispose);await catalogReady;original.assertCurrent()
       }if(opts.managedRuntime!.ownedCode){if(!shellOutput?.sourceFor)throw Error('Original Code output source required');if(!opts.managedRuntime!.ownedShell){for(const tool of createContextOutputTools(shellOutput.service))original.tools.register(tool);original.tools.promote(['context_output_read'])}codeMount=await mountOwnedCode(original,{service:shellOutput.service,sourceFor:shellOutput.sourceFor},codeConfig!)}let surface=registrySurface;if(opts.managedRuntime!.mountDefaultSurface){original.assertCurrent();surface=await opts.managedRuntime!.mountDefaultSurface(original,{modelToolSchemas:()=>codeMount?codeMount.schemas():original.tools.schemas(),modelBinding:()=>{original.assertCurrent();const selected=runtime?runtime.selectedModelBinding():initialBinding;if(!selected)throw Error('Original parent model not bound');return selected},retainTeamRecovery(handle,port){original.assertCurrent();if(row.teamRecovery||!isOriginalTeamRecoveryPort(port,original.domain,handle))throw TypeError('Original Team recovery port required');const resume=Object.getOwnPropertyDescriptor(port,'resume')?.value,close=Object.getOwnPropertyDescriptor(port,'close')?.value;if(typeof resume!=='function'||typeof close!=='function')throw TypeError('Original Team recovery methods required');const gate=Promise.withResolvers<void>();void gate.promise.catch(()=>{});row.teamRecovery={domain:original.domain,handle,port,resume,close,gate,pending:false,stopped:false};original.retain(()=>Reflect.apply(close,port,[]))},...taskMount?{task:taskMount}:{},...taskNotify?{parentNotify:taskNotify}:{},...shellMount?{shell:shellMount.service}:{},...shellOutput?{output:shellOutput}:{}});original.assertCurrent()}if(taskMount){const selected=await resolveModel();original.assertCurrent();initialBinding=selected;initialTaskModel=selected.model;taskLifecycle!.activate();await taskLifecycle!.ready;original.assertCurrent()}if(surface&&types.isProxy(surface))throw TypeError('Original default surface required');const activate=surface&&Object.getOwnPropertyDescriptor(surface,'activateAfterTaskReady');if(activate){if(!taskMount||!('value'in activate)||typeof activate.value!=='function'||types.isProxy(activate.value))throw TypeError('Original staged Team activation required');try{await Reflect.apply(activate.value,surface,[])}catch(error){const state=row.teamRecovery;if(!(error instanceof TeamMountRecoveryRequired)||!state||state.handle!==error.handle||!isOriginalTeamRecoveryPort(state.port,original.domain,state.handle))throw error;state.pending=true;const notify=opts.managedRuntime!.onTeamRecoveryRequired;if(!notify){state.pending=false;throw new AggregateError([error,Error('Team recovery notification unavailable')],'Team recovery cannot await retry',{cause:error})}try{notify(sessionId)}catch(notification){state.pending=false;throw new AggregateError([error,notification],'Team recovery notification failed',{cause:error})}await state.gate.promise}original.assertCurrent();if(Object.getOwnPropertyDescriptor(surface!,'activateAfterTaskReady')?.value!==activate.value)throw Error('Original staged Team activation changed')}return surface},resolveModel,assertConstructionCurrent(){if(retired)throw Error('Original construction retired');assertWritableOpen(sessionId)}})
      }else runtime=createManagedExecutionRuntime({...common,...await resolveModel()})
      await runtime.startSchedule?.()
      assertWritableOpen(sessionId)
      if(opts.managedRuntime!.ownedShell||opts.managedRuntime!.ownedCode||opts.managedRuntime!.ownedTask||opts.managedRuntime!.ownedWorkflow){
        recipient??=receivedExecutionInputsFor(entry.execution).taskDelivery(runtime.domain)
        const published=runtime,originalRecipient=recipient
        privateDrain=createDeliveryDrain({
          current:()=>!retired&&!closed&&!closing.has(sessionId)&&!failedClose.has(sessionId)&&managedRuntimes.get(sessionId)===published,
          reconcile:async()=>{await taskLifecycle?.drain();await originalRecipient.settle();await originalRecipient.reconcileExecCandidates();await originalRecipient.reconcileCodeCandidates();await originalRecipient.reconcileWorkflowCandidates()},
          pending:()=>{const observation=entry.execution.observe();return observation.inbox.pending().filter(input=>['session.delivery.exec','session.delivery.code','session.delivery.subagent','session.delivery.workflow','session.delivery.team'].includes(input.provenance?.producer??'')&&observation.inbox.isExecutable(input.inputId)).map(input=>input.inputId)},
          schedule(inputId,settled){if(retired||managedRuntimes.get(sessionId)!==published)return false;const input=entry.execution.observe().inbox.pending().find(value=>value.inputId===inputId);if(!input)return false;if(queues.get(sessionId)?.byId.get(inputId)?.scheduled||published.lane.currentInput()?.inputId===inputId)return false;void submit(sessionId,input.text,new AbortController().signal,{admittedInputId:inputId}).then(settled,settled);return true},
          report:error=>d.warn('[i-harness] private delivery reconciliation failed: '+String(error)),
        })
        const drain=privateDrain;unsubscribe=subscribeManagedExecution(runtime.domain,event=>{if(['agent/delivery-received','agent/delivery-generation','agent/delivery-source','exec/end','code/end','workflow/end','subagent/end','agent/delivery-handoff','agent/input/promoted','agent/input/cancelled','turn/end'].includes(event.type))drain.signal()})
        unsubscribeReadiness=subscribeManagedExecutionReadiness(runtime.domain,()=>drain.signal(),(error,terminal)=>{if(terminal)drain.retire();if(!retired)d.warn('[i-harness] private delivery readiness unavailable: '+String(error))})
      }
      assertWritableOpen(sessionId);managedRuntimes.set(sessionId,runtime);published=true;managedPrepubSettlers.delete(sessionId);if(rewindMount)managedRewinds.set(sessionId,{handle:rewindMount,runtime});if(title)managedTitles.set(sessionId,title);if(recipient)managedRecipients.set(sessionId,recipient);if(codeMount)managedCodeMounts.set(sessionId,codeMount);if(taskLifecycle)managedTaskOwners.set(sessionId,taskLifecycle);if(workflowMount){const mounted=workflowMount,executor=mounted.executor,list=executor.listJobs.bind(executor),kill=executor.killJob.bind(executor),journal=mounted.reconcileCapturedHandoffs.bind(mounted);managedWorkflowOwners.set(sessionId,{list,kill,journal})}
      publishManaged(sessionId,runtime)
      privateDrain?.signal()
      return runtime
    })().then(work.resolve,error=>{row.failed=true;failedClose.add(sessionId);work.reject(error)})
    return work.promise
  }

  /** Wait only for the same original owner's observable edge; no producer is opened or retried. */
  function waitForManagedInputObservation(sessionId:string,signal:AbortSignal):Promise<number> {
    const runtime=managedRuntimes.get(sessionId)
    if(!runtime)return Promise.reject(Error('Original managed input owner unavailable'))
    return new Promise<number>((resolve,reject)=>{
      let off:(()=>void)|undefined,settled=false
      const finish=(failed:boolean,value?:unknown)=>{if(settled)return;settled=true;signal.removeEventListener('abort',aborted);off?.();if(failed)reject(value);else resolve(value as number)}
      const aborted=()=>finish(true,signal.reason)
      signal.addEventListener('abort',aborted,{once:true})
      if(signal.aborted){aborted();return}
      try{off=subscribeManagedExecutionReadiness(runtime.domain,epoch=>finish(false,epoch),error=>finish(true,error));if(settled)off()}catch(error){finish(true,error)}
    })
  }
  function submit(sessionId: string, prompt: string, signal: AbortSignal, options?: SessionSubmitOptions, deliveryOwner?: SessionAssembly): Promise<void> {
    const run=async()=>{if(!options?.prepareInput&&!deliveryOwner)await prepareFirstParty(sessionId);validateFirstParty(sessionId);return submitUnfenced(sessionId,prompt,signal,options,deliveryOwner)}
    return opts.sessionOperation ? opts.sessionOperation.run(sessionId, run) : run()
  }
  function submitUnfenced(sessionId: string, prompt: string, signal: AbortSignal, options?: SessionSubmitOptions, deliveryOwner?: SessionAssembly): Promise<void> {
    if(privateEntries.has(sessionId)&&!managedCompatible(sessionId))return Promise.reject(Error('Private entry cannot switch to Session-shaped compatibility'))
    if(managedCompatible(sessionId)&&(options?.prepareInput||deliveryOwner))return Promise.reject(Error('Session-shaped input preparation requires complete compatibility before private acquisition'))
    const context = options?.context
    if (context !== undefined && (typeof context !== "string" || context.length > 131072)) return Promise.reject(new Error("Invalid prompt context"))
    const clientToken = options?.clientToken
    if (clientToken !== undefined && (typeof clientToken !== "string" || clientToken.length < 8 || clientToken.length > 128)) return Promise.reject(new Error("Invalid prompt client token"))
    const images = options?.images?.map((image) => ({ ...image }))
    if (images !== undefined) {
      try { if (!Array.isArray(images)) throw new Error("images must be an array"); validateImages(images, "session/prompt") }
      catch (error) { return Promise.reject(error) }
    }
    if (closed) return Promise.reject(new Error("session service closed"))
    if (closing.has(sessionId)) return Promise.reject(new Error(`session closing: ${sessionId}`))
    // M49 Task 11: the STABLE row id + a SERVICE-OWNED controller are created
    // BEFORE the pacing chain (spec §8.1 — a service-front turn must have its
    // own id/controller). The caller signal is LINKED to it (M41b abort
    // semantics flow through: abort the caller's signal → controller aborts →
    // the queued gate settles, the in-flight engine copies abort).
    const st = sessionQueueState(sessionId)
    const id = options?.admittedInputId ?? randomUUID()
    const admitted = options?.admittedInputId ? assemblies.get(sessionId)?.inbox.pending().find((input) => input.inputId === id) : undefined
    if (st.byId.get(id)?.scheduled || laneControls(sessionId)?.currentInput()?.inputId === id) return Promise.reject(new Error("Input is already scheduled"))
    if (admitted?.intent !== "system" && !signal.aborted) cancelledParents.delete(sessionId)
    const controller = new AbortController()
    const record: QueueRowRecord = {
      id,
      text: prompt,
      delivery: admitted?.delivery ?? "queue",
      intent: admitted?.intent ?? "user",
      order: st.nextOrder++,
      controller,
      state: "wait",
      scheduled: true,
    }
    st.byId.set(id, record)
    const markFromCaller = (): void => {
      // M41b: the caller's abort flows INTO the service-owned controller —
      // the queued gate settles (never starts), the in-flight engine aborts
      // (the lane hands the controller signal to agent.run). An unstarted
      // row also flips to cancelled so the projection hides it immediately.
      if (record.state === "wait") record.state = "cancelled"
      controller.abort()
      notifyExecutionState(sessionId)
    }
    signal.addEventListener("abort", markFromCaller)
    if (signal.aborted) markFromCaller()
    const hasQueued = chains.has(sessionId)
    const prev = chains.get(sessionId) ?? Promise.resolve()
    let settle!: () => void
    let settleError!: (error: unknown) => void
    const turn = new Promise<void>((resolve, reject) => { settle = resolve; settleError = reject })
    chains.set(sessionId, turn)
    active.add(turn)
    const cleanup = (): void => {
      signal.removeEventListener("abort", markFromCaller)
      // Exactly-once removal for service rows (settle/error/cancel path); the
      // queue() finished-purge is the read-side twin — both delete idempotently.
      st.byId.delete(id)
      if (chains.get(sessionId) === turn) chains.delete(sessionId)
      active.delete(turn)
      // The lane promise includes stop hooks and its persistence barrier; the
      // service promise also includes post-turn host work. Publish only after
      // removing this row, leaving any following submission visible.
      notifyExecutionState(sessionId)
    }
    // Rejections stay owned: the submit caller gets the rejection in its own
    // handler — the cleanup promise must never surface one (a bare
    // `turn.finally` would propagate it).
    void turn.then(cleanup, cleanup)
    const startTurn = (): void => {
      if (closed || controller.signal.aborted) {
        settle() // the queued turn never starts; the chain keeps moving
        return
      }
      let preparedInput: Awaited<ReturnType<typeof prepareInputExecution>> | undefined
      let preparedManaged: Awaited<ReturnType<typeof prepareExecutionInput>> | undefined
      let closeManaged:(()=>Promise<void>)|undefined
      const managedStart = { wall: Date.now(), monotonic: performance.now() }
      void completeSubmission(async () => {
        const input: AdmittedInput = { inputId: id, text: prompt, preparationPolicy: 'human-host', delivery: 'queue', intent: 'user', provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'session.prompt' },
          ...(context ? { supplementalContext: context } : {}), ...(images?.length ? { images } : {}), ...(clientToken ? { clientToken } : {}) }
        if(managedCompatible(sessionId)){
          const stop=managedStopReceipts.get(sessionId);await awaitDeliveryStop(sessionId);if(stop&&managedStopReceipts.get(sessionId)===stop){managedStopReceipts.delete(sessionId);managedCodeStops.delete(sessionId)}
          if(options?.prepareInput||deliveryOwner)throw Error('Session-shaped input preparation requires complete compatibility before private acquisition')
          const inbox=await receivedInputFor(sessionId)
          if(options?.admittedInputId){
            let lastEpoch:number|undefined
            for(;;){
              let original:import('@i-harness/core-session').PendingInput|undefined
              try{original=inbox.pending().find(p=>p.inputId===id)}
              catch(error){if(!managedRuntimes.has(sessionId))throw error;const epoch=await waitForManagedInputObservation(sessionId,controller.signal);if(epoch===lastEpoch)throw error;lastEpoch=epoch;continue}
              if(!original)return
              if(original.text!==prompt)throw Error('Admitted input does not match submitted text')
              break
            }
          }else await inbox.admit(input,controller.signal)
          controller.signal.throwIfAborted();assertWritableOpen(sessionId)
          const entry=await privateCache!.get(sessionId)
          let runtime:ManagedRuntime | undefined
          let preparationReady=false
          preparedManaged=await prepareExecutionInput({execution:entry.execution,sessionId,inputId:id,signal:controller.signal,start:managedStart,
            ready:async()=>{runtime=await getManagedRuntime(sessionId);controller.signal.throwIfAborted();assertWritableOpen(sessionId);preparationReady=true},
            retain:close=>{let entries=managedIngress.get(sessionId);if(!entries){entries=new Set();managedIngress.set(sessionId,entries)}entries.add(close);closeManaged=async()=>{try{await close()}catch(error){failedClose.add(sessionId);throw error}entries!.delete(close);if(!entries!.size)managedIngress.delete(sessionId)}},
            cancel:inputId=>preparationReady&&!closed&&!closing.has(sessionId)?inbox.cancel(inputId,'input preparation did not reach promotion'):Promise.resolve(false),transform:async text=>runtime?.prepareInput?runtime.prepareInput(text):text,timeoutMs:opts.modelActionTimeoutMs,maxAttempts:opts.modelActionMaxAttempts,passiveGeneration:opts.passiveGeneration})
          try{controller.signal.throwIfAborted();assertWritableOpen(sessionId);record.state='queued';await runtime!.lane.runAdmitted(id,controller.signal,{generation:preparedManaged.generation,preparation:preparedManaged.preparation})}
          catch(error){if(!closed&&!closing.has(sessionId))try{await inbox.cancel(id,'generation ended before promotion')}catch(saving){throw new AggregateError([error,saving],'Private input cancellation requires recovery',{cause:error})}throw error}
          const title=managedTitles.get(sessionId),policy=opts.managedRuntime?.ownedTitle
          if(title&&policy?.enabled&&!controller.signal.aborted){
            record.postTurn=true
            try{
              const selected=runtime!.selectedModelBinding()
              await title.run({execution:entry.execution,sessionId,signal:controller.signal,model:selected.model,selectedClient:()=>runtime!.selectedModelBinding().model,localTestEnabled:opts.modelPolicy==='test-mock',assertCurrent(){controller.signal.throwIfAborted();assertWritableOpen(sessionId);if(managedRuntimes.get(sessionId)!==runtime)throw Error('Original managed runtime retired')},budgetBinding:selected.budgetBinding,contextWindow:selected.contextWindow,maxOutputTokens:selected.maxOutputTokens,titleMaxOutputTokens:policy.titleMaxOutputTokens,timeoutMs:policy.timeoutMs,coordinator:opts.coordinator,passiveGeneration:opts.passiveGeneration})
            }finally{delete record.postTurn}
          }
          return
        }
        const priorAssembly = liveAssembly(sessionId), priorDocument = priorAssembly?.managedDocument
        if (deliveryOwner && priorAssembly !== deliveryOwner) throw new ParentNotificationStoppedError()
        try { await awaitDeliveryStop(sessionId); await priorAssembly?.settleRuntimeContextPublications(); await priorDocument?.settleFinishedActions() }
        catch (failure) {
          if (priorAssembly && !options?.admittedInputId && !controller.signal.aborted && !closed && !closing.has(sessionId) && !failedClose.has(sessionId)) {
            try { await priorAssembly.inbox.admit(input, controller.signal) }
            catch (saving) { throw new AggregateError([failure, saving], 'Input receipt requires recovery', { cause: failure }) }
          }
          throw failure
        }
        controller.signal.throwIfAborted()
        if (closed || closing.has(sessionId) || failedClose.has(sessionId)) throw Object.assign(new Error('FACT_CLOSED'), { code: 'FACT_CLOSED' })
        // A normal active step can claim the hinted receipt while this submit
        // waits in the service chain. That proven consumption is a no-op.
        if (deliveryOwner && liveAssembly(sessionId) !== deliveryOwner) throw new ParentNotificationStoppedError()
        if (options?.admittedInputId && priorAssembly && !priorAssembly.inbox.isPending(id)) {
          const state = readOwnedDeliveryState(priorAssembly.session) ?? readDeliveryIndex(priorAssembly.session)
          if (state.isBound(id) && !state.isEligible(id)) return
        }
        const assembly = opts.coordinator ? await prepareInputExecution({
          passiveGeneration:opts.passiveGeneration,
          ownerSessionId: sessionId,
          acquire: async () => openExecutorDocument({ coordinator: opts.coordinator!, sessionId, session: await writableSessionFor(sessionId) }),
          assemble: () => getOrCreate(sessionId),
          input,
          alreadyAdmitted: !!options?.admittedInputId, signal: controller.signal,
          modelActionTimeoutMs: opts.modelActionTimeoutMs, modelActionMaxAttempts: opts.modelActionMaxAttempts,
          localTestEnabled: opts.modelPolicy === 'test-mock',
          prepare: options?.prepareInput ?? opts.transformPrompt,
        }).then(prepared => { preparedInput = prepared; return prepared.assembly }) : await getOrCreate(sessionId)
        if (deliveryOwner && (assembly !== deliveryOwner || liveAssembly(sessionId) !== deliveryOwner)) throw new ParentNotificationStoppedError()
        if (controller.signal.aborted || closed) return
        const lane = lanes.get(sessionId)!
        await extensionRefreshes.get(sessionId)?.catch(() => undefined)
        const prepared = !preparedInput && !options?.admittedInputId && opts.transformPrompt ? await opts.transformPrompt(assembly, prompt) : prompt
        if (controller.signal.aborted || closed) return
        const text = context ? prepared + '\n\n' + context : prepared
        let execution: Promise<void>
        if (preparedInput) {
          execution = lane.runAdmitted(id, controller.signal, { generation: preparedInput.generation, preparation: preparedInput.preparation })
        } else if (options?.admittedInputId) {
          const pending = assembly.inbox.pending().find(input => input.inputId === id)
          if (!pending) return
          if (pending.text !== text) throw new Error('Admitted input does not match submitted text')
          execution = lane.runAdmitted(id, controller.signal)
        } else {
          await assembly.inbox.admit({ inputId: id, text, delivery: 'queue', intent: 'user', provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'session.prompt' }, ...(images?.length ? { images } : {}), ...(clientToken ? { clientToken } : {}) }, controller.signal)
          execution = lane.runAdmitted(id, controller.signal)
        }
        record.state = 'queued'
        // Keep the entire lane/post-turn/drain flow inside caller settlement.
        await execution
        if (!closed && !controller.signal.aborted && opts.afterSuccessfulSubmit) {
          record.postTurn = true
          try {
            await runPostSubmit({
              passiveGeneration:opts.passiveGeneration,
              sessionId, assembly, signal: controller.signal, localTestEnabled: opts.modelPolicy === 'test-mock',
              binding: () => bindingFor(sessionId), callback: (...args) => opts.afterSuccessfulSubmit!(...args),
              warn: error => d.warn('[i-harness] post-turn host callback failed for ' + sessionId + ': ' + (error instanceof Error ? error.message : String(error))),
            })
          } finally { delete record.postTurn }
        }
      }, () => closeManaged?.() ?? preparedInput?.close(), {
        resolve: settle, reject: settleError,
        report(error) {
          if (!signal.aborted && !closed) telemetry?.emit({ type: 'session/error', ts: Date.now(), data: { sessionId, ...failureDiagnostics(error) } })
        },
      })

    }
    const startOwnedTurn=()=>{try{startTurn()}catch(error){settleError(error)}}
    void prev.then(startOwnedTurn, startOwnedTurn)
    notifyExecutionState(sessionId)
    try { telemetry?.emit({ type: 'session/request', ts: Date.now(), data: { sessionId } }); if(hasQueued)telemetry?.emit({ type: 'session/queued', ts: Date.now(), data: { sessionId } }) } catch { try { d.warn('[i-harness] session telemetry failed') } catch {} }
    return turn
  }

  // ── M49 Task 11: the real queue projection ────────────────────────────────
  // Single read (no UI-derived truth — the projection is the service records +
  // the lane's own truth). Merges service-front and lane rows BY PUBLIC ID;
  // state is "running" through lane execution and service-owned settlement;
  // the running row is first, the rest FIFO. Finished lane-only records are
  // purged here; scheduled submissions remain until their promise cleanup.

  function queue(sessionId: string): SessionQueueItem[] {
    const lane = laneControls(sessionId)
    const st = sessionQueueState(sessionId)
    // Revoked private facts cannot be observed while the original close joins.
    const pending = managedRuntimes.has(sessionId) && (closed || closing.has(sessionId)) ? [] : lane?.pending() ?? []
    const current = lane?.currentInput() ?? undefined
    const pendingIds = new Set(pending.map((p) => p.inputId))

    // Adopt lane-only rows (steers admitted directly into the inbox — the
    // embedded inbound seam) at first sight so they get a stable FIFO order
    // inside the currently admitted window.
    // The adoption window = the highest order among ADMITTED-or-running rows
    // (served or adopted) — service-front ("wait") rows are after the window.
    let window = 0
    for (const rec of st.byId.values()) {
      if (rec.state === "queued" || rec.state === "running") {
        window = Math.max(window, Math.floor(rec.order))
      }
    }
    for (const p of pending) {
      if (st.byId.has(p.inputId)) continue
      st.byId.set(p.inputId, {
        id: p.inputId,
        text: p.text,
        delivery: p.delivery,
        intent: p.intent,
        order: adoptOrder(st, window),
        controller: new AbortController(),
        state: "queued",
      })
    }
    if (current !== undefined && !st.byId.has(current.inputId)) {
      st.byId.set(current.inputId, {
        id: current.inputId,
        text: current.text,
        delivery: current.delivery,
        intent: current.intent,
        order: adoptOrder(st, window),
        controller: new AbortController(),
        state: "running",
      })
    }

    const out: SessionQueueItem[] = []
    const finished: string[] = []
    for (const rec of st.byId.values()) {
      if (rec.state === "cancelled") {
        continue // hidden — the submit settles at its chain hand-over
      }
      if (current?.inputId === rec.id) {
        rec.state = "running"
        out.push({ id: rec.id, text: rec.text, delivery: rec.delivery, intent: rec.intent, state: "running", order: rec.order })
        continue
      }
      if (pendingIds.has(rec.id)) {
        rec.state = "queued"
        out.push({ id: rec.id, text: rec.text, delivery: rec.delivery, intent: rec.intent, state: "queued", order: rec.order })
        continue
      }
      if (rec.postTurn || rec.scheduled && rec.state === "running") {
        // Lane execution finished, but this service submission still owns
        // post-turn settlement work. Its cleanup removes the row.
        out.push({ id: rec.id, text: rec.text, delivery: rec.delivery, intent: rec.intent, state: "running", order: rec.order })
        continue
      }
      if (rec.state === "wait") {
        // service-front: admitted to the chain, not yet to the lane — queued.
        out.push({ id: rec.id, text: rec.text, delivery: rec.delivery, intent: rec.intent, state: "queued", order: rec.order })
        continue
      }
      // The turn's input left the lane (promoted → done): the row is finished
      // even though the submit's chain promise may not have settled yet.
      finished.push(rec.id)
    }
    for (const id of finished) st.byId.delete(id)
    out.sort((a, b) => (a.state === "running" ? -1 : b.state === "running" ? 1 : a.order - b.order))
    return out
  }

  async function cancelQueued(sessionId: string, id: string): Promise<{ cancelled: boolean }> {
    // THE LANE is the ground truth for "running": the record's state is a
    // queue()-read projection and can lag a fresh promotion — consulting it
    // alone would abort a running turn's controller (agent.run's signal) and
    // report an honest-but-false { cancelled: true } (review fix).
    if (laneControls(sessionId)?.currentInput()?.inputId === id) return { cancelled: false }
    const rec = queues.get(sessionId)?.byId.get(id)
    // Already-cancelled / running / unknown ids are all an honest false — the
    // row is no longer cancellable at the moment (the UI refresh shows truth).
    if (rec === undefined || rec.postTurn || rec.state === "running" || rec.state === "cancelled") return { cancelled: false }
    // Abort the row controller (settles the submit's chain gate without
    // executing) and retract a lane-admitted input synchronously — the inbox
    // cancel is append-marked, so the projection drops the row immediately.
    rec.controller.abort()
    const cancelled = await laneControls(sessionId)?.cancel(id)
    if (cancelled?.cancelled === false && laneControls(sessionId)?.currentInput()?.inputId === id) return { cancelled: false }
    rec.state = "cancelled"
    notifyExecutionState(sessionId)
    return { cancelled: true }
  }

  function cancelRunning(sessionId: string): { cancelled: boolean } {
    const teamStopped=stopTeamRecovery(sessionId)
    requestDeliveryStop(sessionId)
    const code=managedCodeMounts.get(sessionId)
    const priorCodeStop=managedCodeStops.get(sessionId)
    if(code&&(!priorCodeStop||priorCodeStop.failed)){const record={flight:Promise.resolve(),failed:false};try{record.flight=Promise.resolve(code.cancel('user-stop')).catch(error=>{record.failed=true;throw error})}catch(error){record.failed=true;record.flight=Promise.reject(error)};managedCodeStops.set(sessionId,record);void record.flight.catch(error=>d.warn('[i-harness] private Code Stop requires cleanup: '+String(error)))}
    stopNotifications(sessionId)
    const current = laneControls(sessionId)?.currentInput()
    if (current !== undefined && laneControls(sessionId)?.cancelCurrent !== undefined) {
      const result = laneControls(sessionId)!.cancelCurrent!()
      if (result.cancelled) stopNotifications(sessionId)
      if (result.cancelled) notifyExecutionState(sessionId)
      return result
    }
    const records = queues.get(sessionId)?.byId
    const postTurn = current === undefined ? [...(records?.values() ?? [])].find(record => record.postTurn) : undefined
    const record = postTurn ?? (current === undefined
      ? [...(records?.values() ?? [])].filter(r => r.state === "wait").sort((a, b) => a.order - b.order)[0]
      : records?.get(current.inputId))
    if (record === undefined || record.controller.signal.aborted) return { cancelled: teamStopped }
    record.controller.abort()
    stopNotifications(sessionId)
    if (current === undefined) record.state = "cancelled"
    notifyExecutionState(sessionId)
    return { cancelled: true }
  }

  const failedClose = new Set<string>()
  const liveAssembly = (sessionId: string) => closed || closing.has(sessionId) || failedClose.has(sessionId) ? undefined : assemblies.get(sessionId)
  const resultReader = createResultPageReader(opts, id => !closed && !closing.has(id) && !failedClose.has(id))
  function revokeSession(sessionId: string): void {
    stopTeamRecovery(sessionId)
    retireManaged(sessionId)
    pendingExecutionNotifications.get(sessionId)?.();pendingExecutionNotifications.delete(sessionId)
    creating.get(sessionId)?.residentActivation.retire()
    deliveryDrains.get(sessionId)?.retire()
    const assembly = assemblies.get(sessionId) ?? mountingAssemblies.get(sessionId)
    if (assembly) receivedInputsFor(assembly.factOwner, sessionId).delivery.revoke()
    opts.coordinator?.revokeManagedDocumentNewWork(sessionId)
    if (assembly) { assembly.revokeNewWork(); retireSurface(sessionId, assembly) }
    for (const row of queues.get(sessionId)?.byId.values() ?? []) row.controller.abort()
  }
  let closeAttempt: Promise<void> | undefined
  function close(): Promise<void> {
    if (closeAttempt) return closeAttempt
    const pending = closeAll()
    closeAttempt = pending
    void pending.then(() => { closeAttempt = undefined }, () => { closeAttempt = undefined })
    return pending
  }
  async function closeAll(): Promise<void> {
    if (closed && ownedAssemblies().size === 0 && creating.size === 0 && privateEntries.size===0 && writableSessions.size === 0 && loadingWriters.size === 0 && notificationStops.size === 0 && firstPartyFlights.size===0 && firstPartyRetained.size===0 && !resultReader.size && !defaultInstructions) return
    closed = true
    const stopAttempts = startNotificationStops()
    defaultInstructions?.dispose()
    for (const id of new Set([...assemblies.keys(), ...mountingAssemblies.keys(), ...privateEntries,...writableSessions.keys(), ...loadingWriters.keys(), ...creating.keys(), ...queues.keys()])) {
      revokeSession(id); stopNotifications(id, stopAttempts)
    }
    const [readerJoined] = await Promise.allSettled([
      resultReader.join(),
      ...active,
      ...firstPartyFlights.values(),
      ...[...creating.values()].map(row => row.work),
      ...loadingWriters.values(),
      ...modelBindings.values(),
      ...closing.values(),
      ...notificationAdmissions.values(),
      ...[...deliveryDrains.values()].map(drain => drain.join()),
    ])
    executionListeners.clear()
    for (const off of executionSubscriptions.values()) off()
    executionSubscriptions.clear()
    let failure: unknown
    try { await opts.beforeDispose?.() } catch (error) { failure = error }
    const failures: unknown[] = readerJoined!.status === 'rejected' ? [readerJoined!.reason] : []
    try { await joinNotificationStops(stopAttempts) } catch (error) { failures.push(error) }
    for (const [id, handle] of ownedAssemblies()) {
      try {
        await disposeOwnedAssembly(handle)
        assemblies.delete(id); mountingAssemblies.delete(id); writableSessions.delete(id); inputInboxes.delete(id); lanes.delete(id); modelBindings.delete(id); chains.delete(id); queues.delete(id); failedClose.delete(id)
        removeSurface(id, handle)
      } catch (error) { failedClose.add(id); failures.push(error) }
    }
    for (const [id, row] of creating) {
      try {
        await row.cleanup?.()
        if (creating.get(id) === row) creating.delete(id)
        writableSessions.delete(id); inputInboxes.delete(id); lanes.delete(id); modelBindings.delete(id); chains.delete(id); queues.delete(id); failedClose.delete(id)
      } catch (error) { row.failed = true; failedClose.add(id); failures.push(error) }
    }
    for (const id of writableSessions.keys()) {
      if (assemblies.has(id) || mountingAssemblies.has(id) || creating.has(id)) continue
      try { await opts.coordinator?.closeManagedDocument(id); writableSessions.delete(id); inputInboxes.delete(id); failedClose.delete(id) }
      catch (error) { failedClose.add(id); failures.push(error) }
    }
    for(const id of [...privateEntries]){
      if(creating.has(id))continue
      try{await drainManagedIngress(id);await privateCache!.close(id);privateCache!.releaseClosed(id);privateEntries.delete(id)}catch(error){failedClose.add(id);failures.push(error)}
    }
    for(const id of [...firstPartyRetained])try{await releaseFirstParty(id)}catch(error){failures.push(error)}
    // Retained assembly publications still own pins in this shared source.
    // Reader-only cleanup debt is independent and must not prevent its close.
    if (defaultInstructions && ownedAssemblies().size === 0 && creating.size === 0) {
      try { await defaultInstructions.close(); defaultInstructions = undefined }
      catch (error) { failures.push(error) }
    }
    if (failures.length) {
      if (failure !== undefined) failures.push(failure)
      throw new AggregateError(failures, "Session service process cleanup incomplete")
    }
    if (failure !== undefined) throw failure
    managedLifecycleListeners.clear();completeSelections.clear();firstPartySelections.clear()
  }

  function closeSession(sessionId: string): Promise<void> {
    if(firstPartyFlights.has(sessionId))firstPartyEpochs.set(sessionId,(firstPartyEpochs.get(sessionId)??0)+1)
    revokeSession(sessionId)
    const existing = closing.get(sessionId)
    if (existing !== undefined) return existing
    const stopAttempts = startNotificationStops(sessionId)
    const retainedStopOwner = [...notificationStops.values()].some(owner => owner.sessionId === sessionId)
    stopNotifications(sessionId, stopAttempts)
    let pending!: Promise<void>
    pending = (async () => {
      const preflight=firstPartyFlights.get(sessionId);if(preflight)await Promise.allSettled([preflight])
      let readerFailure: unknown
      try { await resultReader.join(sessionId) } catch (error) { readerFailure = error }
      const turn = chains.get(sessionId)
      if (turn !== undefined) await Promise.allSettled([turn])
      const build = creating.get(sessionId)
      if (build !== undefined) await build.work.catch(() => undefined)
      const writer = loadingWriters.get(sessionId)
      if (writer !== undefined) await writer.catch(() => undefined)
      const binding = modelBindings.get(sessionId)
      if (binding !== undefined) await Promise.allSettled([binding])
      await Promise.allSettled([...(notificationAdmissions.has(sessionId) ? [notificationAdmissions.get(sessionId)!] : []), deliveryDrains.get(sessionId)?.join()])
      let stopFailure: unknown
      try { await joinNotificationStops(stopAttempts, sessionId) } catch (error) { stopFailure = error }
      const handle = assemblies.get(sessionId) ?? mountingAssemblies.get(sessionId)
      try {
        if (handle) await disposeOwnedAssembly(handle)
        else if (build?.cleanup) await build.cleanup()
        else if(privateEntries.has(sessionId)){await drainManagedIngress(sessionId);await privateCache!.close(sessionId);privateCache!.releaseClosed(sessionId);privateEntries.delete(sessionId)}
        else if (!retainedStopOwner || writableSessions.has(sessionId)) await opts.coordinator?.closeManagedDocument(sessionId)
        if (build && creating.get(sessionId) === build) creating.delete(sessionId)
        await releaseFirstParty(sessionId)
      }
      catch (error) {
        failedClose.add(sessionId)
        const failures: unknown[] = []
        if (readerFailure !== undefined) failures.push(readerFailure)
        if (stopFailure !== undefined) failures.push(stopFailure)
        failures.push(error)
        if (failures.length > 1) throw new AggregateError(failures, 'Session process cleanup incomplete')
        throw error
      }
      if (readerFailure !== undefined) {
        failedClose.add(sessionId)
        if (stopFailure !== undefined) throw new AggregateError([readerFailure, stopFailure], 'Session process cleanup incomplete')
        throw readerFailure
      }
      failedClose.delete(sessionId)
      assemblies.delete(sessionId)
      mountingAssemblies.delete(sessionId)
      if (handle) removeSurface(sessionId, handle)
      writableSessions.delete(sessionId)
      inputInboxes.delete(sessionId)
      lanes.delete(sessionId)
      modelBindings.delete(sessionId)
      chains.delete(sessionId)
      queues.delete(sessionId)
      executionSubscriptions.get(sessionId)?.()
      executionSubscriptions.delete(sessionId)
      notifyExecutionState(sessionId)
      if (stopFailure !== undefined) throw stopFailure
      completeSelections.delete(sessionId);firstPartySelections.delete(sessionId)
    })().finally(() => {
      if (closing.get(sessionId) === pending) closing.delete(sessionId)
    })
    closing.set(sessionId, pending)
    return pending
  }

  async function taskProjectionIntegrity(sessionId: string, options?: { reconcile?: boolean }): Promise<TaskProjectionIssue[]> {
    const owner = managedTaskOwners.get(sessionId)
    if (!owner) throw new TypeError('Original Task projection owner required')
    return options?.reconcile === true ? owner.reconcileProjection() : owner.projectionIntegrity()
  }

  const service:SessionService = {
    async refreshExtensions() {
      if (closed) return
      await Promise.allSettled([...creating.values()].map(row => row.work))
      const jobs = (opts.extensionsFor ? [...assemblies] : []).map(([id, assembly]) => {
        const job = (extensionRefreshes.get(id) ?? Promise.resolve()).catch(() => undefined).then(async () => {
          if (closed || assemblies.get(id) !== assembly) return
          const next = await opts.extensionsFor!(id)
          if (closed || assemblies.get(id) !== assembly) return
          const failures: unknown[] = []
          try { await assembly.updatePluginCapabilities(next.options) } catch (error) { failures.push(error) }
          try {
            if (next.update) await next.update(assembly)
            else {
              await extensionCleanups.get(id)?.(); extensionCleanups.delete(id)
              const cleanup = await next.mount?.(assembly)
              if (cleanup) extensionCleanups.set(id, cleanup)
            }
          } catch (error) { failures.push(error) }
          if (failures.length) throw new AggregateError(failures, "Live plugin update failed")
        })
        extensionRefreshes.set(id, job)
        void job.finally(() => { if (extensionRefreshes.get(id) === job) extensionRefreshes.delete(id) }).catch(() => undefined)
        return job
      })
      if(firstParty?.refresh)for(const [id,runtime] of managedRuntimes){
        const job=(extensionRefreshes.get(id)??Promise.resolve()).catch(()=>undefined).then(async()=>{
          if(closed||managedRuntimes.get(id)!==runtime)return
          await firstParty.refresh!(id)
          if(closed||managedRuntimes.get(id)!==runtime)throw Error('Original managed runtime retired during plugin refresh')
        })
        extensionRefreshes.set(id,job);void job.finally(()=>{if(extensionRefreshes.get(id)===job)extensionRefreshes.delete(id)}).catch(()=>{});jobs.push(job)
      }
      const results = await Promise.allSettled(jobs)
      const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected")
      if (errors.length) throw new AggregateError(errors.map((result) => result.reason), "Some live plugin updates failed")
    },
    submit,
    compact(sessionId, instructions, signal = new AbortController().signal) {
      if(managedCompatible(sessionId)){
        try{assertWritableOpen(sessionId);signal.throwIfAborted();const state=queueState(sessionId);if(state.running||state.queued>0||chains.has(sessionId))throw Error('session is busy')}catch(error){return Promise.reject(error)}
        const work=(async()=>{const runtime=await getManagedRuntime(sessionId);assertWritableOpen(sessionId);signal.throwIfAborted();return runtime.agent.compact(instructions,{signal})})()
        const barrier=work.then(()=>{},()=>{});chains.set(sessionId,barrier);active.add(barrier)
        void barrier.then(()=>{if(chains.get(sessionId)===barrier)chains.delete(sessionId);active.delete(barrier)})
        return work
      }
      const run = async () => {
        assertWritableOpen(sessionId)
        signal.throwIfAborted()
        const state = queueState(sessionId)
        if (state.running || state.queued > 0) throw new Error('session is busy')
        if (!opts.coordinator) return (await getOrCreate(sessionId)).compactNow(instructions)
        return runManualGeneration({ ownerSessionId: sessionId, signal, instructions, timeoutMs: opts.modelActionTimeoutMs,
          passiveGeneration:opts.passiveGeneration,
          localTestEnabled: opts.modelPolicy === 'test-mock',
          acquire: async () => {
            await opts.coordinator!.profile(sessionId)
            return openExecutorDocument({ coordinator: opts.coordinator!, sessionId, session: await writableSessionFor(sessionId) })
          }, assemble: () => getOrCreate(sessionId),
        })
      }
      return opts.sessionOperation ? opts.sessionOperation.run(sessionId, run) : run()
    },
    assemblyFor: getOrCreate,
    modelState,
    contextState,
    taskProjectionIntegrity,
    ...(opts.contextOutput || opts.coordinator?.storageRoot ? { readResultPage: resultReader.read } : {}),
    rebindModel,
    liveSession: (sessionId) => assemblies.get(sessionId)?.session,
    writableSessionFor,
    receivedInputFor,
    managedInputFor,
    liveAssembly,
    instructionState(sessionId, childSessionId) { return liveAssembly(sessionId)?.instructionDiagnostics?.(childSessionId)?.read() ?? { state: 'not-published' } },
    onInstructionsChanged(sessionId, childSessionId, listener) {
      let active = true, assembly: SessionAssembly | undefined, owner: ReturnType<NonNullable<SessionAssembly['instructionDiagnostics']>>, offOwner: (() => void) | undefined, offChildren: (() => void) | undefined
      const emit = () => { if (active) listener() }
      const bind = () => {
        const next = liveAssembly(sessionId), nextOwner = next?.instructionDiagnostics?.(childSessionId)
        if (assembly !== next) { offChildren?.(); offChildren = next?.onSubagentsChanged?.(() => { bind(); emit() }); assembly = next }
        if (owner !== nextOwner) { offOwner?.(); owner = nextOwner; offOwner = owner?.subscribe(emit) }
      }
      const lifecycle = (event: SurfaceLifecycle) => { if (event.sessionId === sessionId) { bind(); emit() } }
      surfaceListeners.add(lifecycle); bind()
      return () => { if (!active) return; active = false; surfaceListeners.delete(lifecycle); offOwner?.(); offChildren?.() }
    },
    async refreshInstructions(sessionId, childSessionId, signal) {
      const assembly = liveAssembly(sessionId), owner = assembly?.instructionDiagnostics?.(childSessionId)
      if (!owner) return { state: 'not-published' }
      const report = await owner.refresh(signal)
      if (liveAssembly(sessionId) !== assembly || assembly?.instructionDiagnostics?.(childSessionId) !== owner) return { state: 'revoked' }
      return report
    },
    hasAssembly: (sessionId) => assemblies.has(sessionId),
    queueState,
    onManagedRuntimeLifecycle:(listener,options)=>{if(closed)return()=>{};managedLifecycleListeners.add(listener);if(options?.includeExisting)for(const [sessionId,record] of managedPublications)if(!record.retired)try{listener({sessionId,owner:record.owner,kind:'published'})}catch{/* Observer isolation. */};return()=>{managedLifecycleListeners.delete(listener)}},
    onExecutionState: listener => {
      if (closed) return () => {}
      executionListeners.add(listener)
      return () => { executionListeners.delete(listener) }
    },
    queue: (sessionId) => queue(sessionId),
    cancelQueued: (sessionId, id) => cancelQueued(sessionId, id),
    cancelRunning,
    awaitDeliveryStop,
    // M49 Task 12: the sessions' task rows — the assembly owns the truth; a
    // session whose assembly does not exist (or was closed) has NO tasks
    // (honest empty, never a fabricated row).
    tasks: (sessionId) => assemblies.get(sessionId)?.tasks() ?? [...(managedTaskOwners.get(sessionId)?.projectTasks()??[]),...projectWorkflowRows(managedWorkflowOwners.get(sessionId)?.list()??[],sessionId)],
    cancelTask: (sessionId, id) => {
      const assembly = assemblies.get(sessionId)
      if (assembly !== undefined) return assembly.cancelTask(id)
      const workflow=managedWorkflowOwners.get(sessionId);if(id.startsWith('workflow-')){if(!workflow?.list().some(job=>job.id===id&&job.owner===sessionId))throw new Error(`unknown task: ${id}`);return workflow.kill(id)}
      const managed=managedTaskOwners.get(sessionId);if(managed)return managed.cancelTask(id)
      throw new Error(`unknown task: ${id}`)
    },
    onAssembly: (hook, options) => {
      if(privateEntries.size)throw Error('Session-shaped callback requires complete compatibility before private acquisition')
      hooks.add(hook)
      try {
        if (options?.includeExisting) {
          for (const [id, assembly] of [...assemblies]) if (assemblies.get(id) === assembly) hook(assembly)
        }
      } catch (error) { hooks.delete(hook); throw error }
      return () => { hooks.delete(hook) }
    },
    onExecutionSurfaceLifecycle: (listener, options) => {
      surfaceListeners.add(listener)
      if (options?.includeExisting) {
        for (const [sessionId, assembly] of ownedAssemblies()) {
          if (!surfaceListeners.has(listener) || !ownsSurface(sessionId, assembly)) continue
          if (assemblies.get(sessionId) !== assembly && surfaceKind(sessionId, assembly) !== 'retiring') continue
          deliverSurface(listener, { sessionId, assembly, kind: surfaceKind(sessionId, assembly) })
        }
      }
      return () => { surfaceListeners.delete(listener) }
    },
    reconcileExecutionAuthority: async (ids) => {
      await Promise.all([...ownedAssemblies()].filter(([id]) => !ids || ids.includes(id)).map(([, assembly]) => assembly.reconcileExecutionAuthority()))
    },
    updateSandboxMode: async (mode) => {
      if (closed || currentSandbox === undefined) throw new Error("sandbox mode is unavailable")
      const changed = currentSandbox !== mode
      const owned = ownedAssemblies()
      if (changed) for (const assembly of owned.values()) await assembly.recordSandboxMode(mode)
      currentSandbox = mode
      await Promise.all([...owned.values()].map(assembly => assembly.reconcileExecutionAuthority()))
    },
    executionBackendStatus: () => Promise.all([...assemblies].map(async ([sessionId, assembly]) => ({ sessionId, status: await assembly.executionBackendStatus() }))),
    closeSession,
    close,
  }
  associateOriginalTeamRetry(service,retryTeamRecovery)
  const readOriginalRuntime=(id:string)=>{if(!privateEntries.has(id))return undefined;const runtime=managedRuntimes.get(id);if(!runtime||closed||closing.has(id))throw Error('Original managed runtime unavailable');const check=()=>{if(closed||closing.has(id)||managedRuntimes.get(id)!==runtime)throw Error('Original managed runtime retired');runtime.domain.assertCurrent()};check();return Object.freeze({execution:runtime.execution,domain:runtime.domain,tools:runtime.tools,assertCurrent:check})}
  associateOriginalManagedExecution(service,{read(id){if(!privateEntries.has(id))return undefined;if(closed||closing.has(id)||!privateCache)throw Error('Original managed execution unavailable');const execution=privateCache.current(id);if(!execution)throw Error('Original managed execution unavailable');return execution},runtime:readOriginalRuntime,async acquireChild(id){if(closed||!privateCache)throw Error('Original managed execution unavailable');const entry=await privateCache.get(id);if(closed){await privateCache.close(id);throw Error('Original managed execution unavailable')}let released=false;return Object.freeze({execution:entry.execution,async release(){if(released)return;released=true;await privateCache!.close(id)}})},async prepareRuntime(id){await prepareFirstParty(id);if(!managedCompatible(id)){if(privateEntries.has(id))throw Error('Private entry cannot switch to Session-shaped compatibility');return undefined}validateFirstParty(id);await getManagedRuntime(id);validateFirstParty(id);return readOriginalRuntime(id)},retain(id,execution,cleanup){if(!privateEntries.has(id)||closed||closing.has(id)||!privateCache)throw Error('Original managed execution unavailable');privateCache.retain(id,execution,cleanup)}})
  associateOriginalManagedRewind(service,id=>{
    if(!privateEntries.has(id))return undefined
    const runtime=managedRuntimes.get(id),row=managedRewinds.get(id)
    if(!runtime||closed||closing.has(id))throw Error('Original managed Rewind unavailable')
    if(!row||row.runtime!==runtime)return {kind:'unavailable'}
    const check=()=>{if(closed||closing.has(id)||managedRuntimes.get(id)!==runtime||managedRewinds.get(id)!==row)throw Error('Original managed Rewind retired');runtime.domain.assertCurrent()}
    return {kind:'ready',store:row.handle.store,assertCurrent:check,async drain(){check();await row.handle.drain();check()},async execute(work){check();const value=await withManagedRewindFacts(runtime.execution,runtime.domain,work);check();return value}}
  })
  associateOriginalHostAssemblyObserver(service,(listener,options)=>{if(closed)return()=>{};hostAssemblyHooks.add(listener);try{if(options?.includeExisting)for(const [id,assembly] of [...assemblies])if(assemblies.get(id)===assembly)listener(assembly)}catch(error){hostAssemblyHooks.delete(listener);throw error}return()=>{hostAssemblyHooks.delete(listener)}})
  return service
}
