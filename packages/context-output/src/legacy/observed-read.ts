import { resolve } from 'node:path'
import { types } from 'node:util'
import { isManagedResultSource,captureManagedHistoryCut,assertManagedHistoryCut } from '../../../core-session/src/managed/view.ts'
import { captureBootstrapPreparationFacts,EMPTY_SEMANTIC_SEED_DIGEST,EMPTY_SEMANTIC_DEPENDENCY_DIGEST,canonicalJsonData } from '@i-harness/core-session'
import type { ContextStore } from '../store.ts'
import type { IndexedLegacyContext } from './index-lifecycle.ts'
import { boundedJson, confirmAtomicJson, ownedPath } from '../artifact/io.ts'
import { appliedFor, canonicalRecord, checkRoot, commitment, fields, recordHash, same, sourceHash } from './fork-codec.ts'
import { expiryBase, expiredTuple, readSlots, revokedTuple } from './fork-disposition.ts'
import { walkPages, rowProof } from './fork-pages.ts'
import { captureSelectedPlanView } from './selected-plan-view.ts'
import { prepareLegacyIndex, verifyPageInventory, type LegacyIndexMutation } from './fork-index.ts'
import type { LegacyCommitment, LegacyReadObservation, LegacyRoot, LegacyRow, LegacyFacts } from './fork-types.ts'
import type { ContextResultRef } from '../types.ts'

export const transferDirectory = (store: ContextStore, invocation: LegacyRoot['binding']['invocation']) => resolve(store.directory, 'legacy-fork-v1', recordHash('binding', invocation))
// Issued only by the original result-observation adapter after resolving its
// own retained document. Copies gain this proof only through capture below.
const originalNoSource=new WeakMap<LegacyReadObservation,{service:object;assertCurrent():void}>()
type OriginalZeroAssociation={document:import('../../../session-persistence/src/coordinator/fact-types.ts').ManagedDocument;view:import('@i-harness/core-session').SessionView}
const originalVerifiers=new WeakMap<object,(observation:LegacyReadObservation)=>OriginalZeroAssociation|undefined>()
const originalServices=new WeakMap<object,()=>void>()
export function registerOriginalZeroSourceService(service:object,assertCurrent:()=>void):void {if(originalServices.has(service)||typeof assertCurrent!=='function'||types.isProxy(assertCurrent))throw Error('Original zero-source service already installed');originalServices.set(service,assertCurrent)}
export function registerOriginalZeroSourceVerifier(service:object,verify:(observation:LegacyReadObservation)=>OriginalZeroAssociation|undefined):void {
  if(!originalServices.has(service)||originalVerifiers.has(service)||typeof verify!=='function'||types.isProxy(verify))throw Error('Original zero-source verifier already installed')
  originalVerifiers.set(service,verify)
}
/** Capture only original data descriptors; callbacks never get to replace them. */
function originalFields(value:object,required:readonly string[],optional:readonly string[]=[]):()=>void {
  fields(value,required,optional)
  const descriptors=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(value)
  return ()=>{
    fields(value,required,optional)
    const now=Object.getOwnPropertyDescriptors(value),current=Reflect.ownKeys(value)
    if(current.length!==keys.length||keys.some(key=>!current.includes(key)))throw Error('Original zero-source fields changed')
    for(const key of keys){const before=Reflect.get(descriptors,key) as PropertyDescriptor,after=Reflect.get(now,key) as PropertyDescriptor;if(!after||!('value'in before)||!('value'in after)||before.value!==after.value||before.enumerable!==after.enumerable||before.configurable!==after.configurable||before.writable!==after.writable)throw Error('Original zero-source field changed')}
  }
}
export function qualifyOriginalZeroSource(service:object,observation:LegacyReadObservation):void {
  const serviceCurrent=originalServices.get(service),verify=originalVerifiers.get(service);if(!serviceCurrent||!verify)return
  const previous=originalNoSource.get(observation);if(previous){if(previous.service===service)previous.assertCurrent();return}
  let qualificationViolated=false;const sentinel={service,assertCurrent(){qualificationViolated=true;throw Error('Original zero-source qualification reentry')}};originalNoSource.set(observation,sentinel)
  try{
  const observationFields=originalFields(observation,['sessionId','sourceId','assertCurrent','localVisible','anchorVisible'],['bootstrap','selectedView','selectedOwner']),sessionId=observation.sessionId,sourceId=observation.sourceId,bootstrap=observation.bootstrap,originalCurrent=observation.assertCurrent
  const bootstrapFields=bootstrap?originalFields(bootstrap,['invocation','manifestDigest','seedDigest']):undefined,invocationFields=bootstrap?originalFields(bootstrap.invocation,['version','operationId','targetSessionId','createdAt','requestDigest']):undefined
  serviceCurrent();const original=verify(observation);if(qualificationViolated)throw Error('Original zero-source qualification reentry');observationFields();bootstrapFields?.();invocationFields?.();if(!original||original.view.header?.semanticSeed?.seedLength!==0)return
  const {document,view}=original
  if(!bootstrap||!bootstrapFields||!invocationFields)throw Error('Original zero-source qualification unavailable')
  const readyDescriptor=Object.getOwnPropertyDescriptor(document,'assertReady'),ready=readyDescriptor&&'value'in readyDescriptor?readyDescriptor.value:undefined
  if(typeof originalCurrent!=='function'||typeof ready!=='function')throw Error('Original zero-source qualification unavailable')
  const checkFields=()=>{observationFields();bootstrapFields();invocationFields();if(observation.sessionId!==sessionId||observation.sourceId!==sourceId||observation.bootstrap!==bootstrap)throw Error('Original zero-source observation changed');const descriptor=Object.getOwnPropertyDescriptor(document,'assertReady');if(!descriptor||!('value'in descriptor)||descriptor.value!==ready||descriptor.enumerable!==readyDescriptor!.enumerable||descriptor.configurable!==readyDescriptor!.configurable||descriptor.writable!==readyDescriptor!.writable)throw Error('Original ready method changed')}
  const assertObservation=()=>Reflect.apply(originalCurrent,observation,[]),assertReady=()=>Reflect.apply(ready,document,[])
  checkFields();assertObservation();assertReady();serviceCurrent()
  const cut=captureManagedHistoryCut(view,document,sessionId),header=view.header,seed=header?.semanticSeed,event=view.events[0]
  if(document.view!==view||!isManagedResultSource(view,document,sessionId)||header?.seedLength!==0||!seed||seed.seedLength!==0||seed.groupCount!==0||seed.seedDigest!==EMPTY_SEMANTIC_SEED_DIGEST||seed.dependencyDigest!==EMPTY_SEMANTIC_DEPENDENCY_DIGEST||event?.type!=='session/bootstrap'||event.seq!==0||event.seedLength!==0||event.operationId!==seed.operationId||event.manifestDigest!==seed.manifestDigest||event.dependencyClosureDigest!==EMPTY_SEMANTIC_DEPENDENCY_DIGEST||bootstrap.invocation.operationId!==seed.operationId||bootstrap.invocation.targetSessionId!==sessionId||bootstrap.invocation.requestDigest!==seed.requestDigest||bootstrap.manifestDigest!==seed.manifestDigest||bootstrap.seedDigest!==seed.seedDigest)throw Error('Original zero-source qualification unavailable')
  captureBootstrapPreparationFacts({version:1,...bootstrap,sourceObservation:{kind:'none'},groupCount:0})
  const identities=()=>{checkFields();if(originalServices.get(service)!==serviceCurrent||originalVerifiers.get(service)!==verify||document.view!==view||!isManagedResultSource(view,document,sessionId)||view.header!==header||view.header?.semanticSeed!==seed||view.events[0]!==event)throw Error('Original zero-source identity changed');assertManagedHistoryCut(cut,view,document,sessionId)}
  identities();assertObservation();assertReady();serviceCurrent();identities()
  let checking=false,reentryViolation=false
  const current=()=>{
    if(checking){reentryViolation=true;throw Error('Original zero-source proof reentry')}
    if(reentryViolation)throw Error('Original zero-source proof reentry')
    checking=true
    try{serviceCurrent();identities();const retained=verify(observation);if(reentryViolation)throw Error('Original zero-source proof reentry');if(!retained||retained.document!==document||retained.view!==view)throw Error('Original zero-source observation unavailable')
      identities();assertObservation();assertReady();serviceCurrent();identities();if(reentryViolation)throw Error('Original zero-source proof reentry')
    }finally{checking=false}
  }
  if(qualificationViolated)throw Error('Original zero-source qualification reentry')
  originalNoSource.set(observation,{service,assertCurrent:current})
  }finally{if(originalNoSource.get(observation)===sentinel)originalNoSource.delete(observation)}
}
export function hasOriginalZeroSource(observation:LegacyReadObservation,service?:object):boolean {const proof=originalNoSource.get(observation);if(!proof||proof.service!==service)return false;proof.assertCurrent();return true}
export function captureObservation(input: LegacyReadObservation,service?:object): LegacyReadObservation {
  fields(input, ['sessionId', 'sourceId', 'assertCurrent', 'localVisible', 'anchorVisible'], ['bootstrap','selectedView','selectedOwner'])
  if (typeof input.sessionId !== 'string' || !input.sessionId || typeof input.sourceId !== 'string' || !input.sourceId || ['assertCurrent', 'localVisible', 'anchorVisible'].some(key => typeof input[key as keyof LegacyReadObservation] !== 'function' || types.isProxy(input[key as keyof LegacyReadObservation]))) throw Error('Invalid legacy observation')
  const originalCurrent=input.assertCurrent.bind(input),localVisible=input.localVisible.bind(input),anchorVisible=input.anchorVisible.bind(input)
  const assertCurrent=()=>{originalCurrent();if(input.selectedView){input.selectedOwner!.assertReady();if(input.selectedOwner!.view!==input.selectedView||!isManagedResultSource(input.selectedView,input.selectedOwner!,input.sessionId))throw Error('Original selected source changed')}}
  let bootstrap: LegacyReadObservation['bootstrap']
  if (input.bootstrap !== undefined) {
    fields(input.bootstrap, ['invocation', 'manifestDigest', 'seedDigest'])
    const f = captureBootstrapPreparationFacts({ version: 1, ...input.bootstrap, sourceObservation: { kind: 'none' }, groupCount: 0 })
    bootstrap = { invocation: f.invocation, manifestDigest: f.manifestDigest, seedDigest: f.seedDigest }
  }
  if(input.selectedView!==undefined&&(!input.selectedView||typeof input.selectedView!=='object'||types.isProxy(input.selectedView)||!input.selectedOwner||!isManagedResultSource(input.selectedView,input.selectedOwner,input.sessionId)||input.selectedOwner.view!==input.selectedView))throw Error('Original selected source view required')
  if(input.selectedOwner!==undefined&&!input.selectedView)throw Error('Selected source view required')
  const captured={ sessionId: input.sessionId, sourceId: input.sourceId, assertCurrent, localVisible, anchorVisible, ...(bootstrap ? { bootstrap } : {}),...(input.selectedView?{selectedView:input.selectedView,selectedOwner:input.selectedOwner}:{}) }
  const proof=originalNoSource.get(input);if(proof&&proof.service===service){proof.assertCurrent();if(!bootstrap||canonicalJsonData(bootstrap)!==canonicalJsonData(input.bootstrap))throw Error('Original zero-source observation changed');const capturedFields=originalFields(captured,['sessionId','sourceId','assertCurrent','localVisible','anchorVisible'],['bootstrap','selectedView','selectedOwner']),copiedBootstrapFields=originalFields(bootstrap,['invocation','manifestDigest','seedDigest']),copiedInvocationFields=originalFields(bootstrap.invocation,['version','operationId','targetSessionId','createdAt','requestDigest']);originalNoSource.set(captured,{service:proof.service,assertCurrent(){proof.assertCurrent();capturedFields();copiedBootstrapFields();copiedInvocationFields()}})}
  return captured
}
export async function loadPlan(store: ContextStore, observation: Pick<LegacyReadObservation, 'bootstrap'|'selectedView'>, guard: () => void): Promise<{ directory: string; root: LegacyRoot;selected?:ReturnType<typeof captureSelectedPlanView> }> {
  if (!observation.bootstrap) throw Error('Legacy bootstrap observation unavailable')
  const directory = transferDirectory(store, observation.bootstrap.invocation), path = resolve(directory, 'plan.json')
  await ownedPath(store.directory, path); guard()
  const root = checkRoot(await boundedJson(path, 65536, store.retireLegacyFile)); guard()
  if(root.version===2&&!observation.selectedView||root.version===1&&observation.selectedView)throw Error('Legacy plan and seed version conflict')
  const selected=root.version===2?captureSelectedPlanView(observation.selectedView!,root,{sessionId:observation.bootstrap!.invocation.targetSessionId,createdAt:observation.bootstrap!.invocation.createdAt}):undefined
  if (root.binding.workspaceId !== store.workspaceId || !same(root.binding.invocation, observation.bootstrap.invocation) || root.binding.manifestDigest !== observation.bootstrap.manifestDigest || root.binding.semanticSeedDigest !== observation.bootstrap.seedDigest) throw Error('Legacy original binding conflict')
  const bindingRecord = canonicalRecord({ version: root.version, kind: 'legacy-fork-binding', binding: root.binding })
  if ((await confirmAtomicJson(store.directory, resolve(directory, 'binding.json'), bindingRecord, store.retireLegacyFile)).kind !== 'confirmed') throw Error('Legacy binding unconfirmed'); guard()
  if ((await confirmAtomicJson(store.directory, path, root, store.retireLegacyFile)).kind !== 'confirmed') throw Error('Legacy plan unconfirmed'); guard()
  if ((await confirmAtomicJson(store.directory, resolve(directory, 'applied.json'), appliedFor(root), store.retireLegacyFile)).kind !== 'confirmed') throw Error('Legacy application unconfirmed'); guard()
  if (await readSlots(store.directory, resolve(directory, 'revoke'), revokedTuple(root), store.retireLegacyFile) !== 'live') throw Error('Legacy grant revoked or unknown'); guard()
  return { directory, root,...(selected?{selected}:{}) }
}
/** Complete graph validation and canonical membership, independent of SQLite
 * hints. Expiry may acknowledge historical application, never live retrieval. */
export async function* verifiedRows(context: IndexedLegacyContext, directory: string, root: LegacyRoot, guard: () => void, facts?: LegacyFacts): AsyncGenerator<LegacyRow> {
  const { store, index } = context
  index.assertCurrent()
  const binding = recordHash('binding', root.binding,root.version), counts = store.legacyCounts(index, binding)
  if (counts.observations !== root.observationCount || counts.refs !== root.distinctRefCount) throw Error('Legacy index preparation required')
  let ordinal = 0
    for await (const row of walkPages(directory, root, guard, facts?.groupCount, store.retireLegacyFile)) {
      if (!same(store.legacyHint(index, binding, ordinal), row)) throw Error('Legacy derived row conflict')
      const c = { refId: row.refId, revision: row.revision, metadataDigest: row.metadataDigest, metadataEncodedBytes: row.metadataEncodedBytes, expiresAt: row.expiresAt }
      if (store.legacyFirst(index, binding, row.refId) === ordinal) {
        const expiry = await readSlots(store.directory, expiryBase(store.directory, c), expiredTuple(store.workspaceId, c), store.retireLegacyFile); guard()
        if (expiry !== 'terminal') {
          if (expiry !== 'live') throw Error('Legacy expiry unknown')
          await store.canonicalRef(c, root.binding.targetSessionId); guard()
        }
      }
      ordinal++; yield row
    }
}
export async function prepareObservedIndex(context: IndexedLegacyContext, observation: LegacyReadObservation, guard: () => void, mutate: LegacyIndexMutation, quota: number): Promise<void> {
  const { store, index } = context
  index.assertCurrent()
  if (!observation.bootstrap) return
  const { directory, root } = await loadPlan(store, observation, guard)
  if (root.binding.targetSessionId !== observation.sessionId || root.binding.targetSourceDigest !== sourceHash(observation.sourceId)) throw Error('Legacy target observation conflict')
  await prepareLegacyIndex(context, directory, root, guard, mutate, quota)
}
export async function observedAllowed(context: IndexedLegacyContext, ref: ContextResultRef, observation: LegacyReadObservation, guard: () => void): Promise<boolean> {
  const { store, index } = context
  index.assertCurrent()
  guard(); if (observation.sessionId === '' || ref.workspaceId !== store.workspaceId) return false
  const c = commitment(ref)
  const sourcePolicy = () => !ref.source || ref.source.sourceId === observation.sourceId
  if (observation.localVisible(c) === true) { guard(); await store.canonicalRef(c, observation.sessionId); guard(); return sourcePolicy() && observation.localVisible(c) === true }
  if (!observation.bootstrap) return false
  try {
    const { directory, root,selected } = await loadPlan(store, observation, guard)
    if (root.binding.targetSessionId !== observation.sessionId || root.binding.targetSourceDigest !== sourceHash(observation.sourceId) || !sourcePolicy()) return false
    if (!store.legacyReady(index, root)) return false
    await verifyPageInventory(context, directory, root, guard)
    let match: LegacyRow | undefined
    for (const hint of store.legacyHints(index, recordHash('binding', root.binding,root.version), ref.id)) {
      // Untrusted derived metadata may reject candidates cheaply; it never
      // authorizes one. Every accepted hint still needs the actual page proof.
      if (!same(c, rowCommitment(hint.row)) || (selected?selected.visible(hint.row):observation.anchorVisible(hint.row.anchor, hint.row.extent,c,hint.row.original)) !== true) continue
      const row = await rowProof(directory, root, hint.ordinal, guard, store.retireLegacyFile)
      if (!same(row, hint.row)) throw Error('Legacy proof hint conflict')
      selected?.row(row)
      if (same(c, rowCommitment(row)) && (selected?selected.visible(row):observation.anchorVisible(row.anchor, row.extent,c,row.original)) === true) { match = row; break }
    }
    guard()
    if (await readSlots(store.directory, expiryBase(store.directory, c), expiredTuple(store.workspaceId, c), store.retireLegacyFile) !== 'live') return false
    guard(); await store.canonicalRef(c, observation.sessionId); guard()
    return match !== undefined && (selected?selected.visible(match):observation.anchorVisible(match.anchor, match.extent,c,match.original)) === true
  } catch (failure) {
    try { index.assertCurrent() } catch { throw failure }
    if ((failure as { code?: string })?.code === 'CONTEXT_INDEX_UNAVAILABLE') throw failure
    if (failure instanceof Error && /derived|hint conflict/i.test(failure.message)) store.rejectIndex(failure)
    guard(); return false
  }
}
export const rowCommitment = (row: LegacyCommitment): LegacyCommitment => ({ refId: row.refId, revision: row.revision, metadataDigest: row.metadataDigest, metadataEncodedBytes: row.metadataEncodedBytes, expiresAt: row.expiresAt })
