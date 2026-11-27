import type {SessionService} from './service.ts'
import type {ManagedExecutionAttachment} from '../../session-persistence/src/execution-internal.ts'
import {isManagedExecutionAttachment} from '../../session-persistence/src/execution-internal.ts'
import {createManagedExecutionDomain,type ManagedExecutionDomain} from '@i-harness/core-session/internal/execution'
import type {PluginContext} from '@i-harness/core-plugin'
import type {SessionBackgroundJob} from './background-job-view.ts'
import type {TerminalReadResult,TerminalView} from '@i-harness/terminal'

export type OriginalProcessJobSelector =
  | Readonly<{ backend: 'shell'; id: string; instanceId: string; sourceId?: string }>
  | Readonly<{ backend: 'workflow' | 'child'; id: string }>

export type OriginalManagedCodeSurface = Readonly<{
  effectiveMode: NonNullable<import('@i-harness/code-mode').CodeModeConfig['mode']>
  surfaceState(): 'available' | 'unavailable' | 'retired'
  onSurfaceChanged(listener: () => void): () => void
  liveCells(): readonly { id: string; status: 'running' }[]
  terminateCell?(cellId: string): Promise<void>
}>

export type OriginalManagedRuntime = Readonly<{
  execution: ManagedExecutionAttachment
  domain: ManagedExecutionDomain
  tools: import('@i-harness/core-tools').ToolRegistry
  /** Passive view from this runtime's owned registries. */
  processes(): SessionBackgroundJob[]
  terminals(): readonly TerminalView[]
  readTerminal(id: string, options?: { offset?: number; maxBytes?: number }): TerminalReadResult | undefined
  closeTerminal(id: string): Promise<TerminalView | undefined>
  cancelProcessJob(selector: OriginalProcessJobSelector): Promise<'cancellation-requested' | 'already-finished'>
  assertCurrent(): void
}>
type Owner={read(id:string):ManagedExecutionAttachment|undefined;runtime(id:string):OriginalManagedRuntime|undefined;prepareRuntime(id:string):Promise<OriginalManagedRuntime|undefined>;retain(id:string,execution:ManagedExecutionAttachment,cleanup:()=>Promise<void>):void;codeSurface?(id:string):OriginalManagedCodeSurface|undefined;acquireChild?(id:string):Promise<Readonly<{execution:ManagedExecutionAttachment;release():Promise<void>}>>}
const owners=new WeakMap<object,Owner>()
/** Internal first-party lookup only; never constructs or publishes a runtime. */
export function associateOriginalManagedExecution(service:SessionService,owner:Owner){if(owners.has(service))throw TypeError('Original managed execution already associated');owners.set(service,owner)}
export function originalManagedExecutionFor(service:SessionService,id:string):ManagedExecutionAttachment|undefined{return owners.get(service)?.read(id)}
export function originalManagedRuntimeFor(service:SessionService,id:string):OriginalManagedRuntime|undefined{return owners.get(service)?.runtime(id)}
export function originalManagedCodeFor(service:object,id:string):OriginalManagedCodeSurface|undefined{return owners.get(service)?.codeSurface?.(id)}
export function prepareOriginalManagedRuntime(service:SessionService,id:string):Promise<OriginalManagedRuntime|undefined>{const owner=owners.get(service);if(!owner)return Promise.reject(TypeError('Original managed execution unavailable'));return owner.prepareRuntime(id)}
/** Host-only acquisition for a CHILD session: no live root runtime exists for it,
 * so this initializes the child's own managed execution attachment (L1 of the
 * child-exec design). The caller must release() when the child closes. */
export async function acquireChildManagedExecution(service:SessionService,id:string):Promise<Readonly<{execution:ManagedExecutionAttachment;release():Promise<void>}>>{
  const owner=owners.get(service)
  if(!owner?.acquireChild)throw TypeError('Original managed execution unavailable')
  return owner.acquireChild(id)
}

/** Child execution domain for a child plugin context (L2 of the child-exec
 * design). The domain is the authority a child-scoped shell/exec factory needs;
 * it is valid only while the child's execution attachment is held. */
export function createChildExecutionDomain(execution:ManagedExecutionAttachment,context:PluginContext):ManagedExecutionDomain{
  if(!isManagedExecutionAttachment(execution))throw TypeError('Original private execution attachment required')
  return createManagedExecutionDomain(execution.identity,execution.owner,context)
}
export function retainManagedExecutionCleanup(service:SessionService,id:string,execution:ManagedExecutionAttachment,cleanup:()=>Promise<void>):void{const owner=owners.get(service);if(!owner)throw TypeError('Original managed execution unavailable');owner.retain(id,execution,cleanup)}
