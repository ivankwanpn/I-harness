import { types } from 'node:util'
import type { PersistenceBackend } from './types.ts'
import {createArtifactPathOwner,type ArtifactPathCapture} from '@i-harness/fs-lock/internal/artifact-path'
import {isOriginalCanonicalPathOwner} from './canonical-path-resolution.ts'
import {associateOriginalCurrentnessGuard,associateOriginalCurrentnessReader,associateOriginalCurrentnessFactory,type OriginalCurrentnessExecutor,type OriginalCurrentnessDescriptorRecipe} from '../../../core-session/src/managed/currentness-guards.ts'
export interface OriginalArtifactPaths {root():string;session(id:string):string;document(key:string):string;taskForParent(id:string):string;prepareRoot():Promise<void>;prepareDocumentParents(key:string):Promise<void>;assertOriginal():void}
export type ArtifactCapture=ArtifactPathCapture & {readonly provisionalKey?:string}
export interface OriginalArtifactExclusion {session(id:string):ArtifactCapture;document(key:string):ArtifactCapture;taskForParent(id:string):ArtifactCapture;prepareSession(id:string):Promise<void>;prepareDocument(key:string):Promise<void>;assertOriginal():void;settleResources():void}
const associations=new WeakMap<object,OriginalArtifactExclusion>()
const canonicalBindings=new WeakSet<object>()
export function isOriginalCanonicalExclusion(binding:OriginalArtifactExclusion|undefined):boolean{return !!binding&&canonicalBindings.has(binding)}
// One pure synchronous owner guard can request the same original proof repeatedly.
// Validate each distinct proof before returning; never retain work across an await.
type ArtifactAssertion = { capture: ArtifactPathCapture; method: () => void }
// Constructor-held frozen native captures cannot replace their method. This
// stores only that descriptor fact; the actual native assertion still runs.
const immutableCaptureMethods=new WeakMap<ArtifactPathCapture,()=>void>()
let assertionWork: Map<ArtifactPathCapture, ArtifactAssertion> | undefined
const pureGuards = new WeakSet<Function>()
const currentnessExecutor:OriginalCurrentnessExecutor=Object.freeze({
  compose(guards:readonly (()=>void)[]){return composeOriginalArtifactGuards(...guards)},
  immediate:withImmediateArtifactCurrentChecks,
  sourceCheck:(operation:()=>void)=>createArtifactCurrentGuard(operation),
  read<T>(operation:()=>T):T{
    if(types.isProxy(operation)||types.isAsyncFunction(operation))throw TypeError('Original synchronous read required')
    let result:T
    withArtifactCurrentChecks(()=>{result=operation();if(types.isPromise(result))throw TypeError('Original synchronous read required')})
    return result!
  },
  bindDescriptors(recipe:OriginalCurrentnessDescriptorRecipe){
    if(!pureGuards.has(recipe.method)||types.isProxy(recipe.receiver))throw TypeError('Original artifact descriptor guard required')
    const check=(fields:typeof recipe.before)=>{for(const [key,value,message]of fields){const field=Object.getOwnPropertyDescriptor(recipe.receiver,key);if(!field||!('value'in field)||field.value!==value)throw TypeError(message??recipe.message)}}
    const immutable=Object.isFrozen(recipe.receiver)
    let beforeVerified=false,afterVerified=false
    return createArtifactCurrentGuard(()=>{if(!beforeVerified){check(recipe.before);beforeVerified=immutable}Reflect.apply(recipe.method,recipe.receiver,[]);if(!afterVerified){check(recipe.after);afterVerified=immutable}})
  },
})
/** Called by the first-party managed producer for its closed scalar getters. */
export function associateArtifactCurrentnessReader(receiver:object,key:PropertyKey):void{associateOriginalCurrentnessReader(receiver,key,currentnessExecutor)}
export function associateArtifactCurrentnessFactory(factory:Function):void{associateOriginalCurrentnessFactory(factory,currentnessExecutor)}
export function createArtifactCurrentGuard(check: () => void): () => void {
  if (typeof check !== 'function' || types.isProxy(check) || types.isAsyncFunction(check)) throw new TypeError('Artifact checks must be synchronous')
  const guard = () => withArtifactCurrentChecks(check)
  pureGuards.add(guard)
  associateOriginalCurrentnessGuard(guard,currentnessExecutor)
  return guard
}
export function isArtifactCurrentGuard(guard: Function): boolean { return pureGuards.has(guard) }
/** Composition accepts exact constructor-enrolled guards, never an unclassified callback. */
export function composeOriginalArtifactGuards(...guards: readonly (() => void)[]): () => void {
  if (guards.some(guard => !pureGuards.has(guard))) throw TypeError('Original artifact guard required')
  return createArtifactCurrentGuard(() => { for (const guard of guards) guard() })
}
export function assertHeldWithArtifactGuard(held: () => void, guard: Function, receiver: object): void {
  const run = () => { held(); Reflect.apply(guard, receiver, []) }
  if (pureGuards.has(guard)) withArtifactCurrentChecks(run)
  else withImmediateArtifactCurrentChecks(run)
}
function flushArtifactChecks(work: Map<ArtifactPathCapture, ArtifactAssertion>): void {
  for (const {capture, method} of work.values()) {
    if(immutableCaptureMethods.get(capture)!==method){const descriptor = Object.getOwnPropertyDescriptor(capture, 'assertCurrent')
    if (!descriptor || !('value' in descriptor) || descriptor.value !== method) throw new TypeError('Changed original artifact assertion')}
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
  const immutable=immutableCaptureMethods.get(capture),descriptor=immutable?undefined:Object.getOwnPropertyDescriptor(capture, 'assertCurrent')
  if (!immutable&&(!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'function' || types.isProxy(descriptor.value))) throw new TypeError('Invalid original artifact assertion')
  const method=immutable??descriptor!.value as ()=>void
  const original = assertionWork?.get(capture)
  if (original && original.method !== method) throw new TypeError('Changed original artifact assertion')
  if (assertionWork) {if(!original)assertionWork.set(capture, {capture, method})}
  else Reflect.apply(method, capture, [])
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
  const immutableOwner=isOriginalCanonicalPathOwner(owner)&&Object.isFrozen(owner)
  let methodsVerified=false
  function methodsCurrent(){if(methodsVerified)return;for(const name of methods){const d=Object.getOwnPropertyDescriptor(owner,name);if(!d||!('value'in d)||d.value!==captured[name])throw TypeError('Changed artifact owner')}methodsVerified=immutableOwner}
  function check(){methodsCurrent();const invoke=()=>{if(Reflect.apply(captured.assertOriginal,owner,[])!==undefined)throw TypeError('Artifact owner check must be synchronous');methodsCurrent()};if(isArtifactCurrentGuard(captured.assertOriginal))invoke();else withImmediateArtifactCurrentChecks(invoke)}
  check();const root=Reflect.apply(captured.root,owner,[]),platform=createArtifactPathOwner(root)
  // Capture wrapper keeps the exact native capture receiver and original methods.
  function capture(kind:'session'|'document'|'taskForParent',id:string):ArtifactCapture{check();const target=Reflect.apply(captured[kind],owner,[id]),original=platform.capture(target);if(!types.isProxy(original)&&Object.isFrozen(original)){const field=Object.getOwnPropertyDescriptor(original,'assertCurrent');if(field&&'value'in field&&typeof field.value==='function'&&!types.isProxy(field.value))immutableCaptureMethods.set(original,field.value)}const result=Object.freeze({...original,...(original.kind==='ready'?{}:{provisionalKey:'artifact-provisional:'+JSON.stringify(target)}),assertCurrent(){if(this!==result)throw TypeError('Invalid artifact capture receiver');check();assertArtifactCurrent(original)}});return result}
  const ensureRoot=async(c:ArtifactCapture)=>{if(c.kind==='needs-root'){c.assertCurrent();await Reflect.apply(captured.prepareRoot,owner,[]);check()}}
  const binding:OriginalArtifactExclusion=Object.freeze({session(id:string){if(this!==binding)throw TypeError('Invalid artifact exclusion receiver');return capture('session',id)},document(key:string){if(this!==binding)throw TypeError('Invalid artifact exclusion receiver');return capture('document',key)},taskForParent(id:string){if(this!==binding)throw TypeError('Invalid artifact exclusion receiver');return capture('taskForParent',id)},async prepareSession(id:string){if(this!==binding)throw TypeError('Invalid artifact exclusion receiver');await ensureRoot(capture('session',id));const session=capture('session',id);if(session.kind!=='ready')throw Error('Original session parent unavailable');let task=capture('taskForParent',id);if(task.kind!=='ready'){await Reflect.apply(captured.prepareDocumentParents,owner,['task-'+id]);check();session.assertCurrent();task=capture('taskForParent',id)}if(task.kind!=='ready')throw Error('Original task artifact parent unavailable');task.assertCurrent()},async prepareDocument(key:string){if(this!==binding)throw TypeError('Invalid artifact exclusion receiver');await ensureRoot(capture('document',key));let c=capture('document',key);if(c.kind!=='ready'){await Reflect.apply(captured.prepareDocumentParents,owner,[key]);check();c=capture('document',key)}if(c.kind!=='ready')throw Error('Original document parent unavailable');c.assertCurrent()},assertOriginal(){if(this!==binding)throw TypeError('Invalid artifact exclusion receiver');check()},settleResources(){if(this!==binding)throw TypeError('Invalid artifact exclusion receiver');platform.settleResources()}})
  associations.set(backend,binding)
  if(isOriginalCanonicalPathOwner(owner))canonicalBindings.add(binding)
}
export function artifactPathsFor(backend:PersistenceBackend){const binding=associations.get(backend);binding?.assertOriginal();return binding}
export type ArtifactExclusionScope = {
  keys: string[]
  ready?: boolean
  assertCurrent(): void
  /** Validate only the original identities consumed by an acquisition step. */
  assertCurrentFor?(ids: readonly string[], keys: readonly string[]): void
}
export function artifactScope(original: OriginalArtifactExclusion | undefined, ids: readonly string[], keys: readonly string[]): ArtifactExclusionScope {
  const sessionIds = [...ids], documentKeys = [...keys]
  const captures = original ? [...sessionIds.map(id => original.session(id)), ...documentKeys.map(key => original.document(key))] : []
  const resources = original ? captures.map(capture => capture.kind === 'ready' ? capture.key : capture.provisionalKey!) : [...sessionIds.map(id => 'legacy-session:' + id), ...documentKeys.map(key => 'legacy-document:' + key)]
  return {
    keys: [...new Set(resources)],
    ready: captures.every(capture => capture.kind === 'ready'),
    assertCurrentFor(selectedIds, selectedKeys) {
      original?.assertOriginal()
      for (let index = 0; index < sessionIds.length; index++) if (selectedIds.includes(sessionIds[index]!)) captures[index]?.assertCurrent()
      for (let index = 0; index < documentKeys.length; index++) if (selectedKeys.includes(documentKeys[index]!)) captures[sessionIds.length + index]?.assertCurrent()
    },
    assertCurrent() {
      original?.assertOriginal()
      for (const capture of captures) capture.assertCurrent()
    },
  }
}
