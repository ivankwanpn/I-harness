import { AsyncLocalStorage } from 'node:async_hooks'
import { types } from 'node:util'
import { bindOriginalCurrentnessDescriptors, callOriginalCurrentnessMethod, runOriginalCurrentnessRead } from '@i-harness/core-session/internal/execution'
import { canonicalJsonData, createLegacyReadVisibility, freezeJsonData, isStrictFactData, type SessionView } from '@i-harness/core-session'
import { captureLegacyRefCommitment, type ContextCapture, type LegacyCommitment, type LegacyReadObservation, type LegacyReadObservationRunner } from '@i-harness/context-output'
import {assertOriginalManagedTaskSourceRead, type ManagedTaskSourceRead} from '@i-harness/session-persistence/internal/selected-source-owner'
import type { ExistingSessionBindingObservation, SessionBindingObservation, SessionCoordinator, SessionMeta, ManagedDocument } from '@i-harness/session-persistence'

const originalResultDocuments=new WeakMap<ResultSourceObservation,ManagedDocument>()
type ResultObservationBase = { sessionId:string; metadata:Readonly<SessionMeta>; source:NonNullable<ContextCapture['source']>; assertCurrent():void }
export type PublicResultSourceObservation = ResultObservationBase & {kind:'public';view:SessionView}
export type ManagedTaskResultSourceObservation = ResultObservationBase & {kind:'managed-task';artifacts:ManagedTaskSourceRead['artifacts'];header:ManagedTaskSourceRead['header']}
export type ResultSourceObservation = PublicResultSourceObservation | ManagedTaskResultSourceObservation
export interface ResultObservationCapture {
  sessionId: string; sessionIds: readonly string[]; observation: ExistingSessionBindingObservation | SessionBindingObservation; document: ManagedDocument
  currentSource(): NonNullable<ContextCapture['source']>; assertHostCurrent(): void
}
export interface ManagedTaskResultObservationCapture {sessionId:string;sessionIds:readonly string[];observation:ExistingSessionBindingObservation|SessionBindingObservation;witness:ManagedTaskSourceRead;currentSource():NonNullable<ContextCapture['source']>;assertHostCurrent():void}
export interface ResultObservationScope {
  run<T>(capture: ResultObservationCapture, use: () => Promise<T>): Promise<T>
  retainManagedTask(capture:ManagedTaskResultObservationCapture): {readonly observation:ManagedTaskResultSourceObservation;assertCurrent():void;revoke():void;use<T>(work:()=>Promise<T>):Promise<T>;close():Promise<void>}
  retainSelected(capture:ResultObservationCapture): {readonly observation:PublicResultSourceObservation;assertCurrent():void;revoke():void;use<T>(work:()=>Promise<T>):Promise<T>;close():Promise<void>}
  current(sessionId: string): ResultSourceObservation | undefined
}
/** Derived held data only. An escaped ALS context remains revoked, never fallback. */
export function createResultObservationScope(): ResultObservationScope {
  type Scope = { active: boolean; ids: Set<string>; primary: ResultSourceObservation }
  const contexts = new AsyncLocalStorage<Scope[]>()
  return {
    retainManagedTask(capture) {
      const observation=capture.observation,witness=capture.witness,sessionId=capture.sessionId,sessionIds=[...capture.sessionIds],hostCheck=capture.assertHostCurrent,sourceGetter=capture.currentSource
      const host=()=>Reflect.apply(hostCheck,capture,[]), checkOwner=()=>assertOriginalManagedTaskSourceRead(witness)
      observation.assertCurrent();host();checkOwner();if(witness.sessionId!==sessionId||!sessionIds.includes(sessionId))throw Error('Result observation actor is not held')
      for(const id of sessionIds)observation.metadata(id)
      const metadata=observation.metadata(sessionId);if(metadata.sessionId!==sessionId||metadata.archived)throw Error('Result observation session unavailable')
      if(canonicalJsonData(metadata.semanticSeed??null)!==canonicalJsonData(witness.header?.semanticSeed??null)||metadata.seedLength!==witness.header?.seedLength)throw Error('Original Task READY header changed')
      const rawSource=Reflect.apply(sourceGetter,capture,[]);if(!isStrictFactData(rawSource))throw Error('Invalid result source')
      const source=freezeJsonData(JSON.parse(canonicalJsonData(rawSource))) as NonNullable<ContextCapture['source']>;let closed=false,active=0,drain=Promise.withResolvers<void>()
      const assertCurrent=()=>{if(closed)throw Error('Result observation expired');observation.assertCurrent();host();checkOwner();if(observation.metadata(sessionId)!==metadata||metadata.archived)throw Error('Result observation metadata changed')}
      const primary:ManagedTaskResultSourceObservation=Object.freeze({kind:'managed-task',sessionId,metadata,artifacts:witness.artifacts,header:witness.header,source,assertCurrent}),ids=new Set(sessionIds)
      originalResultDocuments.set(primary,witness.document);assertCurrent()
      return Object.freeze({observation:primary,assertCurrent,revoke(){closed=true},async use<T>(work:()=>Promise<T>){assertCurrent();active++;const scope:Scope={active:true,ids,primary};try{return await contexts.run([...(contexts.getStore()??[]),scope],async()=>{assertCurrent();const result=await work();assertCurrent();return result})}finally{scope.active=false;if(!--active){drain.resolve();drain=Promise.withResolvers<void>()}}},async close(){if(contexts.getStore()?.some(scope=>scope.primary===primary&&scope.active))throw Error('Result observation self-close');closed=true;if(active)await drain.promise}})
    },
    retainSelected(capture) {
      const observation=capture.observation,document=capture.document,sessionId=capture.sessionId,sessionIds=[...capture.sessionIds],hostCheck=capture.assertHostCurrent,sourceGetter=capture.currentSource
      const host=()=>Reflect.apply(hostCheck,capture,[])
      observation.assertCurrent();host();document.assertReady()
      if(!sessionIds.includes(sessionId))throw Error('Result observation actor is not held')
      for(const id of sessionIds)observation.metadata(id)
      const view=document.view,events=view.events,count=events.length,metadata=observation.metadata(sessionId)
      if(metadata.sessionId!==sessionId||metadata.archived)throw Error('Result observation session unavailable')
      const rawSource=Reflect.apply(sourceGetter,capture,[]);if(!isStrictFactData(rawSource))throw Error('Invalid result source')
      const source=freezeJsonData(JSON.parse(canonicalJsonData(rawSource))) as NonNullable<ContextCapture['source']>
      let closed=false,active=0,drain=Promise.withResolvers<void>()
      const assertCurrent=()=>{if(closed)throw Error('Result observation expired');observation.assertCurrent();host();document.assertReady();if(document.view!==view||view.events!==events||events.length!==count)throw Error('Result observation view changed');if(observation.metadata(sessionId)!==metadata||metadata.archived)throw Error('Result observation metadata changed')}
      const primary:PublicResultSourceObservation=Object.freeze({kind:'public',sessionId,metadata,view,source,assertCurrent}),ids=new Set(sessionIds)
      originalResultDocuments.set(primary,document);assertCurrent()
      return Object.freeze({observation:primary,assertCurrent,revoke(){closed=true},async use<T>(work:()=>Promise<T>){assertCurrent();active++;const scope:Scope={active:true,ids,primary};try{return await contexts.run([...(contexts.getStore()??[]),scope],async()=>{assertCurrent();const result=await work();assertCurrent();return result})}finally{scope.active=false;if(!--active){drain.resolve();drain=Promise.withResolvers<void>()}}},async close(){if(contexts.getStore()?.some(scope=>scope.primary===primary&&scope.active))throw Error('Result observation self-close');closed=true;if(active)await drain.promise}})
    },
    async run(capture, use) {
      capture.observation.assertCurrent(); capture.assertHostCurrent(); capture.document.assertReady()
      if (!capture.sessionIds.includes(capture.sessionId)) throw new Error('Result observation actor is not held')
      for (const id of capture.sessionIds) capture.observation.metadata(id)
      const view = capture.document.view, events = view.events, count = events.length
      const metadata = capture.observation.metadata(capture.sessionId)
      if (metadata.sessionId !== capture.sessionId || metadata.archived) throw new Error('Result observation session unavailable')
      let active = true
      const assertCurrent = () => {
        if (!active) throw new Error('Result observation expired')
        capture.observation.assertCurrent(); capture.assertHostCurrent(); capture.document.assertReady()
        if (capture.document.view !== view || view.events !== events || events.length !== count) throw new Error('Result observation view changed')
        if (capture.observation.metadata(capture.sessionId) !== metadata || metadata.archived) throw new Error('Result observation metadata changed')
      }
      const primary: PublicResultSourceObservation = { kind:'public', sessionId: capture.sessionId, metadata, view,
        get source() { assertCurrent(); const value = capture.currentSource(); assertCurrent(); return value }, assertCurrent }
      originalResultDocuments.set(primary,capture.document)
      const scope: Scope = { active: true, ids: new Set(capture.sessionIds), primary }
      try { return await contexts.run([...(contexts.getStore() ?? []), scope], async () => { assertCurrent(); const value = await use(); assertCurrent(); return value }) }
      finally { active = false; scope.active = false }
    },
    current(sessionId) {
      const current = contexts.getStore()?.findLast(scope => scope.ids.has(sessionId))
      if (!current) return undefined
      if (!current.active) throw new Error('Result observation expired')
      current.primary.assertCurrent()
      if (current.primary.sessionId !== sessionId) throw new Error('Observed result actor has no held ready view')
      return current.primary
    },
  }
}

export async function discoverResultLineage(coordinator: Pick<SessionCoordinator, 'profile'>, sessionId: string, assertCurrent: () => void = () => {}): Promise<string[]> {
  const ids: string[] = []
  let cursor = sessionId
  for (;;) {
    assertCurrent()
    if (ids.includes(cursor) || ids.length >= 64) throw new Error('Result source lineage unavailable')
    ids.push(cursor)
    const { meta } = await coordinator.profile(cursor)
    assertCurrent()
    if (meta.archived) throw new Error('Result source archived')
    // Fork READY sidecars are owned by that target, independent of ancestors.
    if (!meta.parentSession || !['subagent','team'].includes(meta.origin ?? '')) return ids
    cursor = meta.parentSession
  }
}
/** Capture only an already-enrolled original guard. Accessors and foreign
 * assertions retain their ordinary callback path without classification reads. */
export function captureResultLineageGuard(observation: ExistingSessionBindingObservation | SessionBindingObservation): (() => void) | undefined {
  if (types.isProxy(observation)) return
  const current = Object.getOwnPropertyDescriptor(observation, 'assertCurrent')
  const metadata = Object.getOwnPropertyDescriptor(observation, 'metadata')
  if (!current || !('value' in current) || typeof current.value !== 'function'
    || !metadata || !('value' in metadata) || typeof metadata.value !== 'function') return
  const fields = [['assertCurrent', current.value], ['metadata', metadata.value]] as const
  return bindOriginalCurrentnessDescriptors({ receiver: observation, method: current.value,
    before: fields, after: fields, message: 'Original result observation methods changed' })
}
export function assertResultLineage(observation: ExistingSessionBindingObservation | SessionBindingObservation, ids: readonly string[], sessionId: string): void {
  const guard = captureResultLineageGuard(observation)
  const current = guard ?? (() => observation.assertCurrent())
  const read = () => {
    current()
    let cursor = sessionId
    for (const [index, id] of ids.entries()) {
      if (cursor !== id) throw new Error('Result source lineage changed')
      const meta = guard ? callOriginalCurrentnessMethod<Readonly<SessionMeta>>(guard, observation, 'metadata', [id]) : observation.metadata(id)
      if (meta.sessionId !== id || meta.archived) throw new Error('Result source session unavailable')
      const parent = meta.parentSession && ['subagent', 'team'].includes(meta.origin ?? '') ? meta.parentSession : undefined
      if (index === ids.length - 1) { if (parent) throw new Error('Result source lineage expanded') }
      else { if (!parent) throw new Error('Result source lineage changed'); cursor = parent }
    }
    current()
  }
  if (guard) runOriginalCurrentnessRead(guard, read)
  else read()
}

const commitmentKey = (c: LegacyCommitment) => JSON.stringify([c.refId, c.revision, c.metadataDigest, c.metadataEncodedBytes, c.expiresAt])
/** Predicates are synchronous inside L1; failures survive caught-denial paths. */
export function legacyObservationFor(source: ResultSourceObservation): LegacyReadObservation {
  source.assertCurrent()
  if(source.kind==='managed-task') {
    const seed=source.metadata.semanticSeed,header=source.header
    if(!seed||seed.version===3||canonicalJsonData(seed)!==canonicalJsonData(header?.semanticSeed??null)||source.metadata.seedLength!==header?.seedLength)throw Error('Managed Task inherited legacy membership unavailable')
    const bootstrap={invocation:{version:1 as const,operationId:seed.operationId,targetSessionId:source.sessionId,createdAt:source.metadata.createdAt,requestDigest:seed.requestDigest},manifestDigest:seed.manifestDigest,seedDigest:seed.seedDigest}
    const unavailable=()=>{throw Error('Managed Task legacy visibility unavailable')}
    return Object.freeze({sessionId:source.sessionId,sourceId:source.source.sourceId,bootstrap,assertCurrent:source.assertCurrent,localVisible:unavailable,anchorVisible:unavailable})
  }
  const visibility = createLegacyReadVisibility(source.view)
  if (visibility.kind !== 'visible') throw new Error('Legacy visibility ' + visibility.reason)
  const local = new Set([...visibility.local()].map(value => commitmentKey(captureLegacyRefCommitment(value.ref))))
  let failed = false, failure: unknown
  const assertCurrent = () => { if (failed) throw failure; source.assertCurrent() }
  const predicate = <T>(read: () => T): T => { try { assertCurrent(); const value = read(); assertCurrent(); return value } catch (cause) { failed = true; failure = cause; throw cause } }
  const seed = source.metadata.semanticSeed, header = source.view.header
  if (canonicalJsonData(seed ?? null) !== canonicalJsonData(header?.semanticSeed ?? null)
    || source.metadata.seedLength !== header?.seedLength) throw new Error('Legacy READY header changed')
  const bootstrap = seed ? { invocation: { version: 1 as const, operationId: seed.operationId, targetSessionId: source.sessionId, createdAt: source.metadata.createdAt, requestDigest: seed.requestDigest }, manifestDigest: seed.manifestDigest, seedDigest: seed.seedDigest } : undefined
  const originalOwner=originalResultDocuments.get(source),selectedOwner=seed?.version===3?originalOwner:undefined
  if(seed?.version===3&&!selectedOwner)throw Error('Original selected result observation required')
  const result:LegacyReadObservation={ sessionId: source.sessionId, sourceId: source.source.sourceId, ...(bootstrap ? { bootstrap } : {}), ...(selectedOwner?{selectedView:source.view,selectedOwner}:{}), assertCurrent,
    localVisible: c => predicate(() => local.has(commitmentKey(c))), anchorVisible: (anchor, extent, commitment, original) => predicate(() => {
      if(anchor.kind!=='seed-result')return visibility.anchorVisible(anchor,extent)
      const row=visibility.resultRow(anchor,extent)
      return !!row&&!!commitment&&!!original&&commitmentKey(captureLegacyRefCommitment(row.ref))===commitmentKey(commitment)&&canonicalJsonData(row.original)===canonicalJsonData({kind:'local',sessionId:original.sessionId,seq:original.seq,event:'context/result-ref',slot:'ref'})
    }) }
  if(seed?.seedLength===0&&!originalOwner)throw Error('Original result observation required')
  return result
}
export function createLegacyReadObservationRunner(options: {
  coordinator: Pick<SessionCoordinator, 'profile'|'openManagedDocument'|'withExistingSessionBindingObservation'>; observations: ResultObservationScope
  resolveSource(sessionId: string): Promise<(observation: ExistingSessionBindingObservation, ids: readonly string[]) => NonNullable<ContextCapture['source']>>
  assertHostCurrent(): void
  withBindingObservation?<T>(ids: readonly string[], observation: ExistingSessionBindingObservation, use: () => Promise<T>): Promise<T>
}): LegacyReadObservationRunner {
  return async (access, use) => {
    options.assertHostCurrent()
    if (access.signal?.aborted || !options.coordinator.withExistingSessionBindingObservation) throw new Error('Legacy read observation unavailable')
    const document = await options.coordinator.openManagedDocument(access.sessionId)
    document.assertReady(); options.assertHostCurrent()
    const ids = await discoverResultLineage(options.coordinator, access.sessionId, () => { options.assertHostCurrent(); if (access.signal?.aborted) throw new Error('Legacy read cancelled') })
    const currentSource = await options.resolveSource(access.sessionId)
    options.assertHostCurrent()
    return options.coordinator.withExistingSessionBindingObservation({ sessionIds: ids, ...(access.signal ? { signal: access.signal } : {}) }, async observation => {
      const assertHostCurrent = () => { options.assertHostCurrent(); if (access.signal?.aborted) throw new Error('Legacy read cancelled'); assertResultLineage(observation, ids, access.sessionId) }
      const run = () => options.observations.run({ sessionId: access.sessionId, sessionIds: ids, observation, document, currentSource: () => currentSource(observation, ids), assertHostCurrent }, async () => {
        const read = legacyObservationFor(options.observations.current(access.sessionId)!)
        read.assertCurrent(); const value = await use(read); read.assertCurrent(); return value
      })
      return options.withBindingObservation ? options.withBindingObservation(ids, observation, run) : run()
    })
  }
}
