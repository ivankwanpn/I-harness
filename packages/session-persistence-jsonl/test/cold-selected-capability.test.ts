import * as factOwners from '../../session-persistence/src/coordinator/fact-owner.ts'
const prefixGate=vi.hoisted(()=>({path:'',armed:false,gate:undefined as Promise<void>|undefined,entered:undefined as (()=>void)|undefined}))
const metadataPublication=vi.hoisted(()=>({path:'',writes:0,renames:0}))
vi.mock('node:fs/promises',async original=>{const real=await original<typeof import('node:fs/promises')>();return {...real,async readFile(...args:Parameters<typeof real.readFile>){const bytes=await real.readFile(...args);if(prefixGate.armed&&String(args[0])===prefixGate.path){prefixGate.armed=false;prefixGate.entered?.();await prefixGate.gate}return bytes},async writeFile(...args:Parameters<typeof real.writeFile>){if(metadataPublication.path&&String(args[0]).startsWith(metadataPublication.path+'.'))metadataPublication.writes++;return real.writeFile(...args)},async rename(...args:Parameters<typeof real.rename>){if(metadataPublication.path&&String(args[1])===metadataPublication.path)metadataPublication.renames++;return real.rename(...args)}}})
import * as managedLeaf from '../../session-persistence/src/coordinator/managed-document.ts'
import { createJsonlBackend } from '../src/index.ts'
import { composeJsonlTaskTransitionCoordinator } from '../src/task-document-factory.ts'
import * as managedFactories from '../../session-persistence/src/coordinator/managed-documents.ts'
import * as bindings from '../../session-persistence/src/coordinator/binding-observation.ts'
import { lockPathFor } from '../../fs-lock/src/index.ts'
const closeFault=vi.hoisted(()=>({path:'',fail:false,attempts:0,native:0,failure:undefined as unknown}))
vi.mock('../../fs-lock/src/index.ts',async original=>{const real=await original<typeof import('../../fs-lock/src/index.ts')>();return {...real,async acquireSessionLock(...args:Parameters<typeof real.acquireSessionLock>){const lease=await real.acquireSessionLock(...args);return {get held(){return lease.held},async release(){if(args[0].lockPath===closeFault.path){closeFault.attempts++;if(closeFault.fail)throw closeFault.failure;closeFault.native++}await lease.release()}}}}})
import { expect, it, vi } from 'vitest'
import { copyFile, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { decodeFactBatch, encodeFactBatch } from '@i-harness/core-session'
import { codecSeed, codecPage, codecRow, sealCodecSeed } from '../../core-session/test/fixtures/selected-results.ts'
import { createSelectedResultsIntent, readSelectedResultsCore } from '../../session-persistence/src/selected-results-fork-contract.ts'
import { compileSelectedResultsSemanticSeed } from '../../session-persistence/src/semantic-seed.ts'
import { buildSelectedResultsHeader, SELECTED_RESULTS_HEADER_MAX_BYTES } from '../../session-persistence/src/coordinator/selected-results-header.ts'
import * as selected from '../../session-persistence/src/selected-source-owner.ts'
import { selectedBootstrapPaths } from '../src/backend/selected-results-route-path.ts'
import { createJsonlTaskTransitionCoordinator } from '../src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { serializeHeader, snapshotMetadataUpdate } from '../src/format.ts'


async function fixture() {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'cold-cap-'))
  const exported = codecSeed('public-completed', [codecPage([codecRow()])])
  exported.seed.groups = [{ extent: { kind: 'framed', first: 1, last: 1 }, items: [{ kind: 'summary', scope: 'turn', extent: { kind: 'framed', first: 1, last: 1 }, origins: [{ origin: 0, seq: 1, part: 'message' }], sourceProvenance: [{ origin: 0, kind: 'summary', authority: 'derived', scope: 'turn' }], messages: [{ role: 'user', content: 'summary' }] }] }]
  exported.seed.passive.codeStore.groups = [0]
  const seed = compileSelectedResultsSemanticSeed(sealCodecSeed(exported.seed))
  const core = readSelectedResultsCore({ version: 2, kind: 'session-fork-core', sourceSessionId: 'source', selection: { kind: 'completed' }, sourceCapture: 'first-authorized-capture', metadata: {}, results: 'selected-results-v1' })
  const { intent, requestDigest } = createSelectedResultsIntent(core, { kind: 'unmanaged' })
  const invocation = { version: 1 as const, operationId: 'op', targetSessionId: 'target', createdAt: '2026-10-31T00:00:00.000Z', requestDigest }
  const request = { invocation, core, requestIntent: intent }, route = { protocol: 'public-results-v1' as const, request }
  const built = buildSelectedResultsHeader({ invocation, target: { kind: 'new' }, metadata: {}, lineage: { origin: 'fork', parentSession: 'source' }, seed }, { version: 1, kind: 'semantic-bootstrap-selected-results-capture', request })
  const meta = JSON.parse(built.headerBytes), first = encodeFactBatch('bootstrap:op:seed', meta.journal.legacyPrefixDigest, seed.records)
  const complete = encodeFactBatch('bootstrap:op:complete', decodeFactBatch(first.bytes).prefixDigest, [{ type: 'session/bootstrap', version: 1, seq: seed.records.length, operationId: 'op', manifestDigest: meta.semanticSeed.manifestDigest, dependencyClosureDigest: seed.dependencyDigest, seedLength: seed.records.length }])
  const path = join(root, 'target.jsonl'), raw = Buffer.concat([Buffer.from(built.headerBytes), Buffer.from(first.bytes), Buffer.from(complete.bytes)])
  await writeFile(path, raw)
  await writeFile(selectedBootstrapPaths(path, route).stage, built.stageBytes)
  await writeFile(join(root, 'task-target.doc.jsonl'), JSON.stringify(taskDocumentStorageContract.empty()) + '\n')
  const coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  return { root, coordinator, route, raw, path }
}

it('retains the original cold checked target for finite inspection without making it ready', async () => {
  const f = await fixture()
  try {
    const result = await selected.inspectColdSelectedTarget(f.coordinator, f.route)
    expect(result.kind).toBe('qualification-required')
    expect(result).toHaveProperty('target')
    if (result.kind !== 'qualification-required') throw Error('Missing cold target')
    const changed = { ...f.route, request: { ...f.route.request, invocation: { ...f.route.request.invocation, createdAt: '2026-11-01T00:00:00.000Z' } } }
    expect((await selected.inspectColdSelectedTarget(f.coordinator, changed)).kind).toBe('conflict')
    const again = await selected.inspectColdSelectedTarget(f.coordinator, f.route)
    expect(again.kind === 'qualification-required' && again.target).toBe(result.target)
    let original: unknown
    await selected.useColdSelectedTarget(f.coordinator, result.target, async observation => {
      original = observation.document
      expect(observation.document.view).toBe(observation.view)
      expect(observation.view.formatVersion).toBe(14)
      expect(observation.metadata).toEqual(JSON.parse(f.raw.toString().split('\n')[0]!))
      expect(Object.isFrozen(observation.metadata)).toBe(true)
      expect(Object.isFrozen(observation.metadata.journal)).toBe(true)
      expect(observation.receipt.invocation).toEqual(f.route.request.invocation)
      expect(observation.receipt.seedLength).toBe(observation.facts.seedLength)
      expect(observation.prefix.eventCount).toBe(observation.view.events.length)
      expect(observation.birth.stage.seed.seedLength).toBe(observation.facts.seedLength)
      expect(Object.isFrozen(observation.birth)).toBe(true)
      expect(Object.isFrozen(observation.birth.stage.seed)).toBe(true)
      observation.assertCurrent()
      expect(() => observation.document.assertReady()).toThrow()
    })
    await selected.useColdSelectedTarget(f.coordinator, result.target, async observation => { expect(observation.document).toBe(original) })
    await expect(f.coordinator.openManagedDocument('target')).rejects.toThrow()
    await expect(f.coordinator.withProcessReadObservation!('target', { documentKeys: [] }, async () => true, async value => value)).rejects.toThrow()
    expect(await readFile(f.path)).toEqual(f.raw)
  } finally { await f.coordinator.close() }
})

it('never opens or profiles the absent source through the original coordinator during target use', async () => {
  const f = await fixture()
  const load = f.coordinator.loadOwned.bind(f.coordinator), open = f.coordinator.openManagedDocument.bind(f.coordinator), profile = f.coordinator.profile.bind(f.coordinator)
  let sourceReads = 0
  const guard = (id: string) => { if (id === 'source') { sourceReads++; throw Error('Source must remain absent') } }
  const hooks = [
    vi.spyOn(f.coordinator, 'loadOwned').mockImplementation((id, ...args) => { guard(id); return load(id, ...args) }),
    vi.spyOn(f.coordinator, 'openManagedDocument').mockImplementation((id, ...args) => { guard(id); return open(id, ...args) }),
    vi.spyOn(f.coordinator, 'profile').mockImplementation((id, ...args) => { guard(id); return profile(id, ...args) }),
  ]
  try {
    const result = await selected.inspectColdSelectedTarget(f.coordinator, f.route)
    if (result.kind !== 'qualification-required') throw Error('Missing cold target')
    await selected.useColdSelectedTarget(f.coordinator, result.target, async value => { value.assertCurrent(); expect(value.view.header?.parentSession).toBe('source') })
    expect(sourceReads).toBe(0)
  } finally { hooks.forEach(hook => hook.mockRestore()); await f.coordinator.close() }
})

const predecessor = process.env.IH_TASK_D_PREDECESSOR_FIXTURES
it.skipIf(!predecessor)('retains the actual predecessor birth while its owned current target transitions to14', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'cold-cap13-'))
  const source = join(predecessor!, 'selected13-result', 'sessions')
  const stageName = (await readdir(source)).find(name => name.startsWith('target.jsonl.bootstrap-') && name.endsWith('.stage'))!
  await copyFile(join(source, 'target.jsonl'), join(root, 'target.jsonl'))
  await copyFile(join(source, stageName), join(root, stageName))
  const original = await readFile(join(root, 'target.jsonl')), stageBytes = await readFile(join(root, stageName)), stage = JSON.parse(stageBytes.toString())
  const route = { protocol: 'public-results-v1' as const, request: stage.captureReservation.request }
  const coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    const result = await selected.inspectColdSelectedTarget(coordinator, route)
    if (result.kind !== 'qualification-required') throw Error('Missing original13 target')
    await selected.useColdSelectedTarget(coordinator, result.target, async value => {
      expect(value.view.formatVersion).toBe(14)
      expect(value.metadata).toEqual(JSON.parse((await readFile(join(root, 'target.jsonl'), 'utf8')).split('\n')[0]!))
      expect(value.metadata.formatVersion).toBe(14)
      expect(Object.isFrozen(value.metadata)).toBe(true)
      expect(JSON.parse(value.birth.stage.headerBytes).formatVersion).toBe(13)
      expect(value.birth.stage).toEqual(stage)
      value.assertCurrent()
    })
    await coordinator.closeManagedDocument('target')
    expect(await coordinator.updateMeta('target',{title:'predecessor current title'})).toMatchObject({formatVersion:14,title:'predecessor current title'})
    const fresh=await selected.inspectColdSelectedTarget(coordinator,route)
    if(fresh.kind!=='qualification-required')throw Error('Missing edited predecessor')
    await selected.useColdSelectedTarget(coordinator,fresh.target,async value=>{expect(value.metadata.title).toBe('predecessor current title');expect(value.birth.stage).toEqual(stage);value.assertCurrent()})
    const current = await readFile(join(root, 'target.jsonl'))
    expect(current.subarray(current.indexOf(10) + 1)).toEqual(original.subarray(original.indexOf(10) + 1))
    expect(await readFile(join(root, stageName))).toEqual(stageBytes)
    await expect(coordinator.openManagedDocument('target')).rejects.toThrow()
  } finally { await coordinator.close() }
})

it('rejects copied and foreign targets and keeps a finite callback guard local to its use', async () => {
  const f = await fixture(), other = await fixture()
  try {
    const result = await selected.inspectColdSelectedTarget(f.coordinator, f.route)
    expect(result).toHaveProperty('target')
    if (result.kind !== 'qualification-required') throw Error('Missing cold target')
    await expect(selected.useColdSelectedTarget(f.coordinator, { ...result.target }, async () => true)).rejects.toThrow()
    await expect(selected.useColdSelectedTarget(other.coordinator, result.target, async () => true)).rejects.toThrow()
    let guard!: () => void
    await selected.useColdSelectedTarget(f.coordinator, result.target, async observation => {
      guard = observation.assertCurrent
      await expect(f.coordinator.close()).rejects.toThrow()
      observation.assertCurrent()
      await expect(selected.useColdSelectedTarget(f.coordinator, result.target, async () => true)).rejects.toThrow()
    })
    expect(guard).toThrow()
    await f.coordinator.closeManagedDocument!('target')
    await expect(selected.useColdSelectedTarget(f.coordinator, result.target, async () => true)).rejects.toThrow()
  } finally { await Promise.all([f.coordinator.close(), other.coordinator.close()]) }
})

it.each([undefined, null, false, 0, ''])('preserves callback failure %s and permits the same entry to be inspected again', async failure => {
  const f = await fixture()
  try {
    const result = await selected.inspectColdSelectedTarget(f.coordinator, f.route)
    expect(result).toHaveProperty('target')
    if (result.kind !== 'qualification-required') throw Error('Missing cold target')
    const value = await selected.useColdSelectedTarget(f.coordinator, result.target, async () => { throw failure }).then(() => ({ failed: false }), cause => ({ failed: true, cause }))
    expect(value).toEqual({ failed: true, cause: failure })
    await selected.useColdSelectedTarget(f.coordinator, result.target, async observation => observation.assertCurrent())
    await expect(f.coordinator.openManagedDocument('target')).rejects.toThrow()
  } finally { await f.coordinator.close() }
})

it('external close fences the original in-flight use then joins it before releasing the claim', async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  try {
    const result = await selected.inspectColdSelectedTarget(f.coordinator, f.route)
    expect(result).toHaveProperty('target')
    if (result.kind !== 'qualification-required') throw Error('Missing cold target')
    const use = selected.useColdSelectedTarget(f.coordinator, result.target, async observation => { entered.resolve(); await release.promise; observation.assertCurrent() })
    const failedUse = use.then(() => false, () => true)
    await entered.promise
    let closed = false
    const close = f.coordinator.closeManagedDocument!('target').then(() => { closed = true })
    await Promise.resolve()
    expect(closed).toBe(false)
    expect(f.coordinator.ownerOf!('target')).toBe(true)
    release.resolve()
    expect(await failedUse).toBe(true)
    await close
    expect(f.coordinator.ownerOf!('target')).toBe(false)
  } finally { release.resolve(); await f.coordinator.close() }
})

async function prompt<T>(work:Promise<T>){let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([work.then(value=>({kind:'done' as const,value}),cause=>({kind:'rejected' as const,cause})),new Promise<{kind:'pending'}>(resolve=>{timer=setTimeout(()=>resolve({kind:'pending'}),50)})])}finally{if(timer)clearTimeout(timer)}}
it.each(['same','changed','owner'] as const)('refuses self cold inspection before mutation admission: %s',async mode=>{
 const original=bindings.createBindingObservations;let mutation:{mock:{calls:unknown[][]}}|undefined,owner:ReturnType<typeof managedFactories.createManagedDocuments>|undefined
 const makeManaged=managedFactories.createManagedDocuments,managedFactory=vi.spyOn(managedFactories,'createManagedDocuments').mockImplementation((...args)=>{owner=makeManaged(...args);return owner})
 const factory=vi.spyOn(bindings,'createBindingObservations').mockImplementation((...args)=>{const owner=original(...args);mutation=vi.spyOn(owner,'withSelectedBootstrapMutation');return owner})
 const f=await fixture();let nested:Promise<unknown>|undefined;try{const result=await selected.inspectColdSelectedTarget(f.coordinator,f.route);if(result.kind!=='qualification-required')throw Error('Missing target');const route=mode!=='changed'?f.route:{...f.route,request:{...f.route.request,invocation:{...f.route.request.invocation,createdAt:'2026-11-01T00:00:00.000Z'}}};let outcome:Awaited<ReturnType<typeof prompt>>|undefined,unchanged=false
 await selected.useColdSelectedTarget(f.coordinator,result.target,async observation=>{const count=mutation!.mock.calls.length;nested=Promise.resolve().then(()=>mode==='owner'?owner!.inspectColdSelected(route):selected.inspectColdSelectedTarget(f.coordinator,route));outcome=await prompt(nested);unchanged=mutation!.mock.calls.length===count;observation.assertCurrent()});await nested?.catch(()=>{});expect(outcome?.kind).toBe('rejected');expect(unchanged).toBe(true);expect(f.coordinator.ownerOf!('target')).toBe(true);await selected.useColdSelectedTarget(f.coordinator,result.target,async observation=>observation.assertCurrent())
 }finally{managedFactory.mockRestore();factory.mockRestore();await f.coordinator.close()}
})
it('refuses direct original document self-close before lifetime effects',async()=>{
 const f=await fixture();try{const result=await selected.inspectColdSelectedTarget(f.coordinator,f.route);if(result.kind!=='qualification-required')throw Error('Missing target')
 await selected.useColdSelectedTarget(f.coordinator,result.target,async observation=>{await expect(observation.document.close()).rejects.toThrow();observation.assertCurrent();expect(f.coordinator.ownerOf!('target')).toBe(true)});await selected.useColdSelectedTarget(f.coordinator,result.target,async observation=>observation.assertCurrent())
 }finally{await f.coordinator.close()}
})
it('direct escaped document close fences and drains the exact held cold use',async()=>{
 const f=await fixture(),entered=Promise.withResolvers<void>(),leave=Promise.withResolvers<void>();let closing:Promise<void>|undefined,use:Promise<unknown>|undefined;try{const result=await selected.inspectColdSelectedTarget(f.coordinator,f.route);if(result.kind!=='qualification-required')throw Error('Missing target');let document!:import('../../session-persistence/src/coordinator/fact-types.ts').ManagedDocument,guard!:()=>void;await selected.useColdSelectedTarget(f.coordinator,result.target,async observation=>{document=observation.document})
 use=selected.useColdSelectedTarget(f.coordinator,result.target,async observation=>{guard=observation.assertCurrent;entered.resolve();await leave.promise;observation.assertCurrent()}).then(()=>false,()=>true);await entered.promise;closing=document.close();const coordinated=f.coordinator.closeManagedDocument!('target');expect(guard).toThrow();const state=await prompt(closing);expect(state.kind).toBe('pending');expect(f.coordinator.ownerOf!('target')).toBe(true);leave.resolve();expect(await use).toBe(true);await closing;await coordinated;expect(f.coordinator.ownerOf!('target')).toBe(false)
 }finally{leave.resolve();await use;await closing?.catch(()=>{});await f.coordinator.close()}
})
it.each([undefined,0])('retains direct cold close ownership and retries original cleanup failure %s',async failure=>{
 const f=await fixture();try{const result=await selected.inspectColdSelectedTarget(f.coordinator,f.route);if(result.kind!=='qualification-required')throw Error('Missing target');let document!:import('../../session-persistence/src/coordinator/fact-types.ts').ManagedDocument;await selected.useColdSelectedTarget(f.coordinator,result.target,async observation=>{document=observation.document});closeFault.path=lockPathFor(f.root,'target');closeFault.failure=failure;closeFault.fail=true;closeFault.attempts=closeFault.native=0
 expect(await document.close().then(()=>({failed:false}),cause=>({failed:true,cause}))).toEqual({failed:true,cause:failure});expect(f.coordinator.ownerOf!('target')).toBe(true);expect((await selected.inspectColdSelectedTarget(f.coordinator,f.route)).kind).toBe('blocked');await expect(f.coordinator.openManagedDocument('target')).rejects.toThrow();await expect(f.coordinator.withProcessReadObservation!('target',{documentKeys:[]},async()=>true,async value=>value)).rejects.toThrow();closeFault.fail=false;await document.close();expect(closeFault.attempts).toBe(2);expect(closeFault.native).toBe(1);expect(f.coordinator.ownerOf!('target')).toBe(false);const reopened=await selected.inspectColdSelectedTarget(f.coordinator,f.route);if(reopened.kind!=='qualification-required')throw Error('Cold target not reusable');await document.close();await selected.useColdSelectedTarget(f.coordinator,reopened.target,async observation=>observation.assertCurrent())
 }finally{closeFault.fail=false;await f.coordinator.close();closeFault.path=''}
})
it('keeps composed ordinary document and coordinator close behavior intact',async()=>{
 const f=await fixture();try{await f.coordinator.create({sessionId:'ordinary'});const document=await f.coordinator.openManagedDocument('ordinary');document.assertReady();await document.close();await document.close();const reopened=await f.coordinator.openManagedDocument('ordinary');expect(reopened).not.toBe(document);reopened.assertReady();await f.coordinator.closeManagedDocument!('ordinary');await f.coordinator.close();expect(f.coordinator.ownerOf!('ordinary')).toBe(false)}finally{await f.coordinator.close()}
})

it.each(['clean','cleanup-debt'] as const)('closes the exact document attached during an ordinary opening flight: %s',async mode=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'late-attach-')),backend=createJsonlBackend(root),entered=Promise.withResolvers<void>(),leave=Promise.withResolvers<void>(),closingEntered=Promise.withResolvers<void>()
 let registry:ReturnType<typeof managedFactories.createManagedDocuments>|undefined,document:ReturnType<typeof managedLeaf.createManagedDocument>|undefined,resolved:Map<unknown,unknown>|undefined,attempts=0,fail=mode==='cleanup-debt'
 const makeManaged=managedFactories.createManagedDocuments,factory=vi.spyOn(managedFactories,'createManagedDocuments').mockImplementation((...args)=>{registry=makeManaged(...args);const close=registry.closeOne;vi.spyOn(registry,'closeOne').mockImplementation(async id=>{closingEntered.resolve();return close(id)});return registry})
 const makeDocument=managedLeaf.createManagedDocument,leaf=vi.spyOn(managedLeaf,'createManagedDocument').mockImplementation((...args)=>{const doc=makeDocument(...args);if(args[0]==='ordinary'){document=doc;const close=doc.close.bind(doc);vi.spyOn(doc,'close').mockImplementation(async()=>{attempts++;if(fail){fail=false;throw undefined}await close()})}return doc})
 const coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract),held=factOwners.heldFactOwner,read=vi.spyOn(factOwners,'heldFactOwner').mockImplementation((...args)=>{const original=held(...args);if(args[0].sessionId==='ordinary'&&args[0].incarnation==='cold-recovery')prefixGate.armed=true;return original})
 prefixGate.path=join(root,'ordinary.jsonl');prefixGate.gate=leave.promise;prefixGate.entered=entered.resolve
 const set=Map.prototype.set,map=vi.spyOn(Map.prototype,'set').mockImplementation(function(this:Map<unknown,unknown>,key:unknown,value:unknown){if(key==='ordinary'&&document&&value===document)resolved=this;return set.call(this,key,value)})
 let opening:Promise<import('../../session-persistence/src/coordinator/fact-types.ts').ManagedDocument>|undefined,closing:Promise<{failed:boolean;cause?:unknown}>|undefined
 try{
  await coordinator.create({sessionId:'ordinary'});opening=coordinator.openManagedDocument('ordinary');await entered.promise;expect(document).toBeUndefined();expect(JSON.parse((await readFile(join(root,'ordinary.jsonl'),'utf8')).split('\n')[0]!).formatVersion).toBe(14)
  closing=coordinator.closeManagedDocument!('ordinary').then(()=>({failed:false}),cause=>({failed:true,cause}));await closingEntered.promise;expect((await prompt(closing)).kind).toBe('pending');leave.resolve();const opened=await opening;expect(opened).toBe(document);expect(()=>opened.assertReady()).toThrow();const outcome=await closing
  expect(attempts).toBe(1);expect(resolved).toBeDefined()
  if(mode==='cleanup-debt'){expect(outcome).toEqual({failed:true,cause:undefined});expect(registry!.has('ordinary')).toBe(true);expect(resolved!.get('ordinary')).toBe(opened);expect(()=>registry!.captureProcessReadById('ordinary',[])).toThrow();await coordinator.closeManagedDocument!('ordinary');expect(attempts).toBe(2)}else expect(outcome.failed).toBe(false)
  expect(registry!.has('ordinary')).toBe(false);expect(resolved!.has('ordinary')).toBe(false);await opened.close();expect(attempts).toBe(mode==='cleanup-debt'?2:1)
  if(mode==='clean'){read.mockRestore();const next=await coordinator.openManagedDocument('ordinary');expect(next).not.toBe(opened);next.assertReady();await opened.close();next.assertReady()}
 }finally{fail=false;leave.resolve();prefixGate.path='';prefixGate.armed=false;await opening?.catch(()=>{});await closing;await coordinator.close();map.mockRestore();read.mockRestore();leaf.mockRestore();factory.mockRestore()}
})


it('updates completed selected metadata through the original coordinator and cold binding', async()=>{
 const f=await fixture();try{
  const stagePath=selectedBootstrapPaths(f.path,f.route).stage,stage=await readFile(stagePath),body=f.raw.subarray(f.raw.indexOf(10)+1)
  let old:Awaited<ReturnType<typeof selected.inspectColdSelectedTarget>>|undefined
  for(const patch of [{title:'Live selected title'},{archived:true},{archived:false,workspaceId:'workspace',modelSelection:{provider:'route',model:'model',protocol:'openai-responses' as const,reasoningEffort:'high'}}]){
  const updated=await f.coordinator.updateMeta('target',patch)
  expect(updated).toMatchObject(patch)
  const current=await readFile(f.path);expect(current.subarray(current.indexOf(10)+1)).toEqual(body);expect(await readFile(stagePath)).toEqual(stage)
  const result=await selected.inspectColdSelectedTarget(f.coordinator,f.route);expect(result.kind).toBe('qualification-required');if(result.kind!=='qualification-required')throw Error('Missing live metadata target')
  if(old?.kind==='qualification-required')await expect(selected.useColdSelectedTarget(f.coordinator,old.target,async()=>{})).rejects.toThrow()
  await selected.useColdSelectedTarget(f.coordinator,result.target,async value=>{
   expect(value.metadata).toMatchObject(patch);expect(value.metadata.title).toBe('Live selected title');value.assertCurrent();expect(()=>value.document.assertReady()).toThrow()
   await expect(f.coordinator.updateMeta('target',{title:'self'})).rejects.toThrow();value.assertCurrent()
  })
  await expect(f.coordinator.updateMeta('target',{title:'unready'})).rejects.toThrow()
  expect(await readFile(f.path)).toEqual(current)
  await f.coordinator.closeManagedDocument('target');old=result
  }
 }finally{await f.coordinator.close()}
})

it.each(['formatVersion','journal','semanticSeed','seedLength','parentSession','origin','delegationDepth','subagentProtocolVersion','sessionId','createdAt'])('refuses protected selected metadata patches before publication: %s',async key=>{
 const f=await fixture();try{
  const original=JSON.parse(f.raw.subarray(0,f.raw.indexOf(10)).toString()),stagePath=selectedBootstrapPaths(f.path,f.route).stage,stage=await readFile(stagePath)
   for(const patch of [{[key]:null},Object.defineProperty({},key,{enumerable:true,get(){throw Error('protected getter')}}),{toJSON(){const next={...original};if(Object.hasOwn(next,key))delete next[key];else next[key]=1;return next}},{get title(){original.semanticSeed.operationId='forged';return 'smuggled'},semanticSeed:original.semanticSeed}]){
    await expect(f.coordinator.updateMeta('target',patch as never)).rejects.toThrow()
    expect(await readFile(f.path)).toEqual(f.raw);expect(await readFile(stagePath)).toEqual(stage)
    await f.coordinator.close()
    f.coordinator=createJsonlTaskTransitionCoordinator(f.root,{lock:{enabled:true}},taskDocumentStorageContract)
   }
  const current=JSON.parse(f.raw.subarray(0,f.raw.indexOf(10)).toString())
  expect(await f.coordinator.updateMeta('target',{semanticSeed:current.semanticSeed,toJSON(){return {...current,title:'serialized title'}}} as never)).toMatchObject({title:'serialized title'})
 }finally{await f.coordinator.close()}
})

it('keeps the generic serializer closed and preserves exact torn bytes at the original selected backend boundary',async()=>{
 const f=await fixture();try{
  const meta=JSON.parse(f.raw.subarray(0,f.raw.indexOf(10)).toString())
  expect(()=>serializeHeader(meta)).toThrow('Legacy header writer')
  expect(()=>snapshotMetadataUpdate(meta,{title:'generic'})).toThrow('Legacy header writer')
  await f.coordinator.create({sessionId:'ordinary'})
  expect(await f.coordinator.updateMeta('ordinary',{title:'ordinary title',workspaceId:'workspace'})).toMatchObject({title:'ordinary title',workspaceId:'workspace'})
  const backend=createJsonlBackend(f.root),torn=Buffer.concat([f.raw,Buffer.from([0x7b,0xff,0x00])])
  await writeFile(f.path,torn)
  expect(await backend.updateMeta('target',{title:'backend exact body'})).toMatchObject({title:'backend exact body'})
  const current=await readFile(f.path)
  expect(current.subarray(current.indexOf(10)+1)).toEqual(torn.subarray(torn.indexOf(10)+1))
 }finally{await f.coordinator.close()}
})

it.each(['stage','immutable','frame'] as const)('refuses supported metadata publication after original birth corruption: %s',async mode=>{
 const f=await fixture();try{
  if(mode==='stage')await writeFile(selectedBootstrapPaths(f.path,f.route).stage,'{}')
  else if(mode==='immutable'){const end=f.raw.indexOf(10),meta=JSON.parse(f.raw.subarray(0,end).toString());meta.createdAt='changed';await writeFile(f.path,Buffer.concat([Buffer.from(JSON.stringify(meta)+'\n'),f.raw.subarray(end+1)]))}
  else {const raw=Buffer.from(f.raw);raw[raw.length-3]=0;await writeFile(f.path,raw)}
  const before=await readFile(f.path),stage=await readFile(selectedBootstrapPaths(f.path,f.route).stage)
  await expect(f.coordinator.updateMeta('target',{title:'refused'})).rejects.toThrow()
  expect(await readFile(f.path)).toEqual(before);expect(await readFile(selectedBootstrapPaths(f.path,f.route).stage)).toEqual(stage)
 }finally{await f.coordinator.close()}
})

it.each(['ascii','multibyte','newline','toJSON'] as const)('SLM-R2 rejects oversized detached UTF-8 header before publication: %s',async mode=>{
 const f=await fixture();try{
  const meta=JSON.parse(f.raw.subarray(0,f.raw.indexOf(10)).toString()),stagePath=selectedBootstrapPaths(f.path,f.route).stage,stage=await readFile(stagePath)
  const emptyBytes=Buffer.byteLength(JSON.stringify({...meta,title:''})+'\n','utf8'),room=SELECTED_RESULTS_HEADER_MAX_BYTES-emptyBytes
  const title=mode==='multibyte'?'界'.repeat(Math.ceil(room/3)+1):mode==='newline'?'x'.repeat(room+1):'x'.repeat(SELECTED_RESULTS_HEADER_MAX_BYTES)
  const line=JSON.stringify({...meta,title})
  expect(Buffer.byteLength(line+'\n','utf8')).toBeGreaterThan(SELECTED_RESULTS_HEADER_MAX_BYTES)
  if(mode==='multibyte')expect(line.length+1).toBeLessThan(SELECTED_RESULTS_HEADER_MAX_BYTES)
  if(mode==='newline')expect(Buffer.byteLength(line,'utf8')).toBe(SELECTED_RESULTS_HEADER_MAX_BYTES)
  const patch=mode==='toJSON'?{title:'short',toJSON(){return {...meta,title}}}:{title}
  metadataPublication.path=f.path;metadataPublication.writes=metadataPublication.renames=0
  await expect(f.coordinator.updateMeta('target',patch as never)).rejects.toThrow()
  expect(metadataPublication.writes).toBe(0);expect(metadataPublication.renames).toBe(0)
  metadataPublication.path=''
  expect(await readFile(f.path)).toEqual(f.raw);expect(await readFile(stagePath)).toEqual(stage)
  // The original transition can conservatively poison its local failed attempt;
  // retire it before testing the preserved persisted target with a fresh owner.
  await f.coordinator.close();f.coordinator=createJsonlTaskTransitionCoordinator(f.root,{lock:{enabled:true}},taskDocumentStorageContract)
  const old=await selected.inspectColdSelectedTarget(f.coordinator,f.route)
  if(old.kind!=='qualification-required')throw Error('Rejected metadata damaged cold target')
  await selected.useColdSelectedTarget(f.coordinator,old.target,async value=>{expect(value.metadata.title).toBe(meta.title);value.assertCurrent()})
  await f.coordinator.closeManagedDocument('target')
  expect(await f.coordinator.updateMeta('target',{title:'corrective valid title'})).toMatchObject({title:'corrective valid title'})
  const fresh=await selected.inspectColdSelectedTarget(f.coordinator,f.route)
  if(fresh.kind!=='qualification-required')throw Error('Missing corrected target')
  await selected.useColdSelectedTarget(f.coordinator,fresh.target,async value=>{expect(value.metadata.title).toBe('corrective valid title');value.assertCurrent()})
  const raw=await readFile(f.path);expect(raw.subarray(raw.indexOf(10)+1)).toEqual(f.raw.subarray(f.raw.indexOf(10)+1));expect(await readFile(stagePath)).toEqual(stage)
 }finally{metadataPublication.path='';await f.coordinator.close()}
})

it.each(['x','界'])('SLM-R2 accepts the exact UTF-8 line boundary including LF: %s',async character=>{
 const f=await fixture();try{
  const meta=JSON.parse(f.raw.subarray(0,f.raw.indexOf(10)).toString()),room=SELECTED_RESULTS_HEADER_MAX_BYTES-Buffer.byteLength(JSON.stringify({...meta,title:''})+'\n','utf8')
  const width=Buffer.byteLength(character,'utf8'),title=character.repeat(Math.floor(room/width))+'x'.repeat(room%width)
  expect(await f.coordinator.updateMeta('target',{title})).toMatchObject({title})
  const raw=await readFile(f.path);expect(raw.indexOf(10)+1).toBe(SELECTED_RESULTS_HEADER_MAX_BYTES)
  expect(raw.subarray(raw.indexOf(10)+1)).toEqual(f.raw.subarray(f.raw.indexOf(10)+1))
  const result=await selected.inspectColdSelectedTarget(f.coordinator,f.route)
  if(result.kind!=='qualification-required')throw Error('Exact boundary not readable')
  await selected.useColdSelectedTarget(f.coordinator,result.target,async value=>{expect(value.metadata.title).toBe(title);value.assertCurrent()})
  await f.coordinator.closeManagedDocument('target')
  expect(await f.coordinator.updateMeta('target',{title:'small title'})).toMatchObject({title:'small title'})
 }finally{await f.coordinator.close()}
})
