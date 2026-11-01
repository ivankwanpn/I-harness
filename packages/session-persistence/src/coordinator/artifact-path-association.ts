import { types } from 'node:util'
import type { PersistenceBackend } from './types.ts'
import {createArtifactPathOwner,type ArtifactPathCapture} from '@i-harness/fs-lock/internal/artifact-path'
export interface OriginalArtifactPaths {root():string;session(id:string):string;document(key:string):string;taskForParent(id:string):string;prepareRoot():Promise<void>;prepareDocumentParents(key:string):Promise<void>;assertOriginal():void}
export type ArtifactCapture=ArtifactPathCapture & {readonly provisionalKey?:string}
export interface OriginalArtifactExclusion {session(id:string):ArtifactCapture;document(key:string):ArtifactCapture;taskForParent(id:string):ArtifactCapture;prepareSession(id:string):Promise<void>;prepareDocument(key:string):Promise<void>;assertOriginal():void;settleResources():void}
const associations=new WeakMap<object,OriginalArtifactExclusion>()
// One pure synchronous owner guard can request the same original proof repeatedly.
// Validate each distinct proof before returning; never retain work across an await.
type ArtifactAssertion = { capture: ArtifactPathCapture; method: () => void }
let assertionWork: Map<ArtifactPathCapture, ArtifactAssertion> | undefined
const pureGuards = new WeakSet<Function>()
export function createArtifactCurrentGuard(check: () => void): () => void {
  if (typeof check !== 'function' || types.isProxy(check) || types.isAsyncFunction(check)) throw new TypeError('Artifact checks must be synchronous')
  const guard = () => withArtifactCurrentChecks(check)
  pureGuards.add(guard)
  return guard
}
export function isArtifactCurrentGuard(guard: Function): boolean { return pureGuards.has(guard) }
export function assertHeldWithArtifactGuard(held: () => void, guard: Function, receiver: object): void {
  const run = () => { held(); Reflect.apply(guard, receiver, []) }
  if (pureGuards.has(guard)) withArtifactCurrentChecks(run)
  else withImmediateArtifactCurrentChecks(run)
}
function flushArtifactChecks(work: Map<ArtifactPathCapture, ArtifactAssertion>): void {
  for (const {capture, method} of work.values()) {
    const descriptor = Object.getOwnPropertyDescriptor(capture, 'assertCurrent')
    if (!descriptor || !('value' in descriptor) || descriptor.value !== method) throw new TypeError('Changed original artifact assertion')
    Reflect.apply(method, capture, [])
  }
}
export function withImmediateArtifactCurrentChecks(check: () => void): void {
  const outer = assertionWork
  assertionWork = undefined
  try { if (outer) { flushArtifactChecks(outer); outer.clear() }; check() }
  finally { assertionWork = outer }
}
export function assertArtifactCurrent(capture: ArtifactPathCapture): void {
  const descriptor = Object.getOwnPropertyDescriptor(capture, 'assertCurrent')
  if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'function' || types.isProxy(descriptor.value)) throw new TypeError('Invalid original artifact assertion')
  const original = assertionWork?.get(capture)
  if (original && original.method !== descriptor.value) throw new TypeError('Changed original artifact assertion')
  if (assertionWork) assertionWork.set(capture, {capture, method: descriptor.value})
  else Reflect.apply(descriptor.value, capture, [])
}
export function withArtifactCurrentChecks(check: () => void): void {
  if (typeof check !== 'function' || types.isProxy(check) || types.isAsyncFunction(check)) throw new TypeError('Artifact checks must be synchronous')
  if (assertionWork) { if (check() !== undefined) throw new TypeError('Artifact checks must return synchronously'); return }
  const work = new Map<ArtifactPathCapture, ArtifactAssertion>()
  assertionWork = work
  try { if (check() !== undefined) throw new TypeError('Artifact checks must return synchronously') }
  finally { assertionWork = undefined }
  flushArtifactChecks(work)
}
export function associateArtifactPaths(backend:PersistenceBackend,owner:OriginalArtifactPaths):void{
  if(types.isProxy(owner))throw TypeError('Original artifact owner required')
  if(associations.has(backend))throw TypeError('Backend already associated')
  const methods=['root','session','document','taskForParent','prepareRoot','prepareDocumentParents','assertOriginal'] as const
  const captured=Object.fromEntries(methods.map(name=>{const d=Object.getOwnPropertyDescriptor(owner,name);if(!d||!('value'in d)||typeof d.value!=='function')throw TypeError('Invalid original artifact owner');return[name,d.value]})) as unknown as OriginalArtifactPaths
  function methodsCurrent(){for(const name of methods){const d=Object.getOwnPropertyDescriptor(owner,name);if(!d||!('value'in d)||d.value!==captured[name])throw TypeError('Changed artifact owner')}}
  function check(){methodsCurrent();const invoke=()=>{if(Reflect.apply(captured.assertOriginal,owner,[])!==undefined)throw TypeError('Artifact owner check must be synchronous');methodsCurrent()};if(isArtifactCurrentGuard(captured.assertOriginal))invoke();else withImmediateArtifactCurrentChecks(invoke)}
  check();const root=Reflect.apply(captured.root,owner,[]),platform=createArtifactPathOwner(root)
  // Capture wrapper keeps the exact native capture receiver and original methods.
  function capture(kind:'session'|'document'|'taskForParent',id:string):ArtifactCapture{check();const target=Reflect.apply(captured[kind],owner,[id]),original=platform.capture(target);const result=Object.freeze({...original,...(original.kind==='ready'?{}:{provisionalKey:'artifact-provisional:'+JSON.stringify(target)}),assertCurrent(){if(this!==result)throw TypeError('Invalid artifact capture receiver');check();assertArtifactCurrent(original)}});return result}
  const ensureRoot=async(c:ArtifactCapture)=>{if(c.kind==='needs-root'){c.assertCurrent();await Reflect.apply(captured.prepareRoot,owner,[]);check()}}
  const binding:OriginalArtifactExclusion=Object.freeze({session(id:string){if(this!==binding)throw TypeError('Invalid artifact exclusion receiver');return capture('session',id)},document(key:string){if(this!==binding)throw TypeError('Invalid artifact exclusion receiver');return capture('document',key)},taskForParent(id:string){if(this!==binding)throw TypeError('Invalid artifact exclusion receiver');return capture('taskForParent',id)},async prepareSession(id:string){if(this!==binding)throw TypeError('Invalid artifact exclusion receiver');await ensureRoot(capture('session',id));const session=capture('session',id);if(session.kind!=='ready')throw Error('Original session parent unavailable');let task=capture('taskForParent',id);if(task.kind!=='ready'){await Reflect.apply(captured.prepareDocumentParents,owner,['task-'+id]);check();session.assertCurrent();task=capture('taskForParent',id)}if(task.kind!=='ready')throw Error('Original task artifact parent unavailable');task.assertCurrent()},async prepareDocument(key:string){if(this!==binding)throw TypeError('Invalid artifact exclusion receiver');await ensureRoot(capture('document',key));let c=capture('document',key);if(c.kind!=='ready'){await Reflect.apply(captured.prepareDocumentParents,owner,[key]);check();c=capture('document',key)}if(c.kind!=='ready')throw Error('Original document parent unavailable');c.assertCurrent()},assertOriginal(){if(this!==binding)throw TypeError('Invalid artifact exclusion receiver');check()},settleResources(){if(this!==binding)throw TypeError('Invalid artifact exclusion receiver');platform.settleResources()}})
  associations.set(backend,binding)
}
export function artifactPathsFor(backend:PersistenceBackend){const binding=associations.get(backend);binding?.assertOriginal();return binding}
export type ArtifactExclusionScope = {keys:string[];ready?:boolean;assertCurrent():void}
export function artifactScope(original:OriginalArtifactExclusion|undefined,ids:readonly string[],keys:readonly string[]):ArtifactExclusionScope{const captures=original?[...ids.map(id=>original.session(id)),...keys.map(key=>original.document(key))]:[],resources=original?captures.map(c=>c.kind==='ready'?c.key:c.provisionalKey!):[...ids.map(id=>'legacy-session:'+id),...keys.map(key=>'legacy-document:'+key)];return{keys:[...new Set(resources)],ready:captures.every(c=>c.kind==='ready'),assertCurrent(){original?.assertOriginal();for(const c of captures)c.assertCurrent()}}}
