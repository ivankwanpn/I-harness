import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, open, rename, readdir, writeFile, copyFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as persistence from '@i-harness/session-persistence'
import { EMPTY_SEMANTIC_SEED_DIGEST, EMPTY_SEMANTIC_DEPENDENCY_DIGEST, createSession, append, exportConversationSeed, legacyPrefixDigest } from '@i-harness/core-session'
import { createJsonlBackend } from '../src/index.ts'
import { createSessionCoordinator } from './helpers/composed.ts'

const roots: string[] = [], coordinators: any[] = []
vi.mock('node:fs/promises', async original => { const fs=await original<typeof import('node:fs/promises')>(); return {...fs,open:vi.fn(fs.open),rename:vi.fn(fs.rename)} })
const installCut=vi.hoisted(()=>({enabled:false}))
vi.mock('@i-harness/core-session/internal/bootstrap',async original=>{
  const api=await original<typeof import('@i-harness/core-session/internal/bootstrap')>()
  return {...api,createBootstrapManagedSessionState:(...args:Parameters<typeof api.createBootstrapManagedSessionState>)=>{
    const state=api.createBootstrapManagedSessionState(...args),stage=state.stage
    state.stage=events=>{const staged=stage(events);return {...staged,install(){if(installCut.enabled){installCut.enabled=false;throw new Error('controlled installation cut')}staged.install()}}}
    return state
  }}
})
afterEach(async () => { for (const c of coordinators.splice(0)) await c.close().catch(() => {}); for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }) })
type BootstrapHooks = { append?: (actual: any, ...args: any[]) => any; confirm?: (actual: any, ...args: any[]) => any }
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'ih-bootstrap-')); roots.push(root)
  const hooks: BootstrapHooks = {}
  // The bootstrap frame writers are bound before the canonical-path guard
  // snapshots the backend descriptors; patching them afterwards is
  // PROCESS_READ_UNAVAILABLE by design.
  const backend = createJsonlBackend(root, { wrap: b => {
    const append = b.appendOwnedBatch!.bind(b), confirm = b.confirmBootstrapFrames!.bind(b)
    b.appendOwnedBatch = ((...args: any[]) => hooks.append ? hooks.append(append, ...args) : (append as any)(...args)) as typeof b.appendOwnedBatch
    b.confirmBootstrapFrames = ((...args: any[]) => hooks.confirm ? hooks.confirm(confirm, ...args) : (confirm as any)(...args)) as typeof b.confirmBootstrapFrames
  } })
  const coordinator = createSessionCoordinator(backend, { lock: { enabled: true } }); coordinators.push(coordinator)
  return { root, backend, coordinator: coordinator as any, hooks }
}
const request = ():persistence.BootstrapRequest => ({ invocation: { version: 1, operationId: 'operation', targetSessionId: 'target', createdAt: '2026-10-23T00:00:00.000Z', requestDigest: 'a'.repeat(64) },
  target: { kind: 'new' }, metadata: { title: 'original' }, lineage: { origin: 'fork', parentSession: 'parent' },
  seed: { digest: EMPTY_SEMANTIC_SEED_DIGEST, dependencyDigest: EMPTY_SEMANTIC_DEPENDENCY_DIGEST, sourceObservation: { kind: 'none' }, records: [] } })
const guards = { assertCurrent() {}, dependencies: { async confirm() { throw new Error('empty dependencies must not call port') }, async reconcile() { throw new Error('empty dependencies must not call port') } } }
it('rejects hidden bootstrap fields before reservation and preserves ordinary model metadata', async () => {
  const { coordinator } = await setup(), r = request()
  Object.defineProperty(r.metadata, 'hiddenAuthority', { value: 'not JSON', enumerable: false })
  expect(await coordinator.bootstrapSemanticTarget(r, guards)).toEqual({ kind: 'refused', reason: 'manifest-invalid' })
  expect((await coordinator.inspectBootstrap(r.invocation)).kind).toBe('absent')
  const ordinary = request(); ordinary.metadata.modelSelection = { provider: 'test', model: 'model', reasoningEffort: 'high' }
  expect((await coordinator.bootstrapSemanticTarget(ordinary, guards)).kind).toBe('ready')
})
it('prepares an empty target before completion outside its session operation and passively reconciles before READY', async () => {
  const { coordinator } = await setup(), r = request(), calls: string[] = []
  const targetPreparation = {
    async confirm(input: any, current: () => boolean) {
      calls.push('confirm'); expect(current()).toBe(true)
      expect(input.invocation).toEqual(r.invocation)
      expect(await coordinator.inspectBootstrap(r.invocation)).toMatchObject({ kind: 'reserved', token: { manifestDigest: input.manifestDigest } })
      await expect(coordinator.profile('target')).rejects.toThrow()
      return { kind: 'confirmed' as const }
    },
    async reconcile() { calls.push('reconcile'); return { kind: 'confirmed' as const } },
    assertTargetCurrent() { calls.push('current') },
  }
  expect((await coordinator.bootstrapSemanticTarget(r, { ...guards, targetPreparation })).kind).toBe('ready')
  expect(calls[0]).toBe('confirm'); expect(calls).toContain('reconcile'); expect(calls.at(-1)).toBe('current')
  calls.length = 0
  expect((await coordinator.resumeSemanticTarget(r.invocation, { ...guards, assertCurrent() { throw new Error('source gone') }, targetPreparation })).kind).toBe('already-ready')
  expect(calls[0]).toBe('reconcile')
})
it('keeps empty target reserved when configured preparation is blocked or stale', async () => {
  const { coordinator, root } = await setup(), r = request()
  const targetPreparation = { async confirm() { return { kind: 'blocked', reason: 'unavailable' } }, async reconcile() { throw new Error('not reached') }, assertTargetCurrent() {} }
  expect(await coordinator.bootstrapSemanticTarget(r, { ...guards, targetPreparation })).toMatchObject({ kind: 'blocked', reason: 'dependency-unavailable', token: { phase: 'dependencies' } })
  expect((await readFile(join(root, 'target.jsonl'), 'utf8')).trimEnd().split('\n')).toHaveLength(1)
})
it.each(['host', 'dependency', 'seed', 'confirmation'])('rechecks target authority after the actual %s await before issuing or exposing READY', async cut => {
  const { coordinator, root, hooks } = await setup(), r = dependent(), calls: string[] = []
  let available = true
  hooks.append = async (append, ...args) => { const result = await append(...args); if (cut === 'seed' && args[3].key.batchId.endsWith(':seed')) available = false; return result }
  hooks.confirm = async (confirm, ...args) => { const result = await confirm(...args); if (cut === 'confirmation') available = false; return result }
  const closure = 'b'.repeat(64)
  const targetPreparation = {
    async confirm() { calls.push('host'); if (cut === 'host') available = false; return { kind: 'confirmed' as const } },
    async reconcile() { calls.push('reconcile-host'); return { kind: 'confirmed' as const } },
    assertTargetCurrent() { if (!available) throw new Error('target revoked') },
  }
  const outcome = await coordinator.bootstrapSemanticTarget(r, { assertCurrent() {}, targetPreparation, dependencies: {
    async confirm() { calls.push('dependency'); if (cut === 'dependency') available = false; return { kind: 'confirmed', closureDigest: closure } },
    async reconcile() { calls.push('reconcile-dependency'); return { kind: 'confirmed', closureDigest: closure } },
  } })
  expect(outcome).toMatchObject({ kind: 'blocked', reason: 'dependency-unavailable' })
  expect(calls[0]).toBe('host')
  if (cut === 'host') expect(calls).not.toContain('dependency')
  const bytes = await readFile(join(root, 'target.jsonl'), 'utf8')
  expect(bytes.includes('bootstrap:operation:complete')).toBe(cut === 'confirmation')
  if (cut === 'host' || cut === 'dependency') expect(bytes.trimEnd().split('\n')).toHaveLength(1)
  await expect(coordinator.openManagedDocument('target')).rejects.toThrow()
})
it('captures the preparation callbacks before the first await and rejects non-closed outcomes', async () => {
  const { coordinator, root } = await setup(), r = request()
  const targetPreparation = {
    async confirm() { return Object.defineProperty({ kind: 'confirmed' as const }, 'hidden', { value: true }) },
    async reconcile() { return { kind: 'confirmed' as const } }, assertTargetCurrent() {},
  }
  const pending = coordinator.bootstrapSemanticTarget(r, { ...guards, targetPreparation })
  targetPreparation.confirm = async () => ({ kind: 'confirmed' })
  expect(await pending).toMatchObject({ kind: 'blocked', reason: 'dependency-unavailable' })
  expect((await readFile(join(root, 'target.jsonl'), 'utf8')).trimEnd().split('\n')).toHaveLength(1)
})
it.each(['omitted', 'undefined'])('review F1 captures %s target preparation before a caller adds a port', async mode => {
  const { coordinator, root } = await setup(), r = request()
  let injected = 0, sourceChecks = 0
  const original: persistence.BootstrapGuards = {
    ...guards,
    assertCurrent() { expect(this).toBe(original); sourceChecks++ },
    ...(mode === 'undefined' ? { targetPreparation: undefined } : {}),
  }
  const pending = coordinator.bootstrapSemanticTarget(r, original)
  original.targetPreparation = {
    async confirm() { injected++; return { kind: 'blocked', reason: 'unavailable' } },
    async reconcile() { injected++; return { kind: 'blocked', reason: 'unavailable' } },
    assertTargetCurrent() { injected++ },
  }
  expect((await pending).kind).toBe('ready')
  expect(injected).toBe(0); expect(sourceChecks).toBeGreaterThan(0)
  expect((await readFile(join(root, 'target.jsonl'), 'utf8')).trimEnd().split('\n')).toHaveLength(2)
})
it.each(['inherited', 'inherited-accessor', 'own-accessor', 'own-hidden'])('review F1 rejects %s target preparation without evaluating it or reserving a target', async mode => {
  const { coordinator, root } = await setup(), r = request()
  let reads = 0, callbacks = 0
  const port = {
    async confirm() { callbacks++; return { kind: 'confirmed' as const } },
    async reconcile() { callbacks++; return { kind: 'confirmed' as const } },
    assertTargetCurrent() { callbacks++ },
  }
  const original = { ...guards }
  if (mode === 'inherited') Object.setPrototypeOf(original, { targetPreparation: port })
  else if (mode === 'inherited-accessor') Object.setPrototypeOf(original, Object.defineProperty({}, 'targetPreparation', { get() { reads++; return port } }))
  else if (mode === 'own-accessor') Object.defineProperty(original, 'targetPreparation', { enumerable: true, get() { reads++; return port } })
  else Object.defineProperty(original, 'targetPreparation', { value: port })
  expect(await coordinator.bootstrapSemanticTarget(r, original)).toEqual({ kind: 'refused', reason: 'manifest-invalid' })
  expect(reads).toBe(0); expect(callbacks).toBe(0)
  expect((await coordinator.inspectBootstrap(r.invocation)).kind).toBe('absent')
  expect((await readdir(root)).filter(path => path.endsWith('.jsonl') || path.endsWith('.stage'))).toEqual([])
})
it.each([false, true])('review F1 preserves other guard receivers and live Stop while preparation absence stays captured (aborted=%s)', async aborted => {
  const { coordinator } = await setup(), controller = new AbortController()
  const original: persistence.BootstrapGuards = Object.assign(Object.create({ assertCurrent() { expect(this).toBe(original) } }), { signal: controller.signal, dependencies: guards.dependencies })
  const pending = coordinator.bootstrapSemanticTarget(request(), original)
  if (aborted) controller.abort()
  expect(await pending).toMatchObject(aborted ? { kind: 'not-issued', reason: 'cancelled' } : { kind: 'ready' })
})
it('review F1 preserves the captured preparation method receiver and function references', async () => {
  const { coordinator } = await setup()
  let checks = 0
  const targetPreparation: persistence.BootstrapTargetPreparationPort = {
    async confirm() { this.assertTargetCurrent(); return { kind: 'confirmed' } },
    async reconcile() { this.assertTargetCurrent(); return { kind: 'confirmed' } },
    assertTargetCurrent() { checks++ },
  }
  const pending = coordinator.bootstrapSemanticTarget(request(), { ...guards, targetPreparation })
  targetPreparation.assertTargetCurrent = () => { throw new Error('late replacement') }
  expect((await pending).kind).toBe('ready'); expect(checks).toBeGreaterThan(1)
})
it('rechecks target authority at the original seed issue guard after backend awaits and permits a fresh attempt', async () => {
  const { coordinator, root, hooks } = await setup(), r = seeded()
  let available = true, cut = true
  hooks.append = async (append, ...args) => {
    if (cut && args[3].key.batchId.endsWith(':seed')) {
      cut = false
      await readFile(join(root, 'target.jsonl'))
      available = false
    }
    return append(...args)
  }
  const targetPreparation = { async confirm() { return { kind: 'confirmed' as const } }, async reconcile() { return { kind: 'confirmed' as const } }, assertTargetCurrent() { if (!available) throw new Error('revoked') } }
  expect(await coordinator.bootstrapSemanticTarget(r, { ...guards, targetPreparation })).toMatchObject({ kind: 'blocked', reason: 'dependency-unavailable' })
  expect((await readFile(join(root, 'target.jsonl'), 'utf8')).trimEnd().split('\n')).toHaveLength(1)
  available = true
  expect((await coordinator.resumeSemanticTarget(r.invocation, { ...guards, targetPreparation }, r)).kind).toBe('ready')
  expect((await readFile(join(root, 'target.jsonl'), 'utf8')).match(/"batchId":"bootstrap:operation:seed"/g)).toHaveLength(1)
})
function seeded(initial=false):any {
  const r:any=request(),source=createSession();append(source,{type:'user/message',text:'original source'})
  const exported=exportConversationSeed(source,{kind:'session',sessionId:'parent'},{kind:'all'})
  if(exported.kind!=='seed')throw new Error('seed refused')
  r.seed=persistence.compileSemanticSeed(exported)
  if(initial)r.initial={inputId:'initial',text:'do task once',parentSessionId:'parent',startedAt:100,expiresAt:200}
  return r
}
function dependent(anonymous=false):persistence.BootstrapRequest {
  const r=request(),source=createSession()
  const ref={version:1 as const,id:'ctxv1_'+'c'.repeat(64),revision:'d'.repeat(64),codec:'json-utf8-v1' as const,encodedBytes:10,contentDigest:'e'.repeat(64),completeness:'complete' as const}
  append(source,{type:'step/start'});append(source,{type:'tool/call',callId:'ref',name:'read',args:{}});append(source,{type:'assistant/message',text:''})
  append(source,{type:'tool/result',callId:'ref',name:'read',envelope:{version:1,execution:{outcome:'succeeded',dispatch:'dispatched'},preview:'artifact preview',media:[],retention:{kind:'artifact',ref}}});append(source,{type:'step/end'})
  const exported=exportConversationSeed(source,anonymous?{kind:'anonymous'}:{kind:'session',sessionId:'parent'},{kind:'all'})
  if(exported.kind!=='seed')throw new Error('dependency export refused')
  r.seed=persistence.compileSemanticSeed(exported)
  if(anonymous)r.lineage={origin:'import'}
  return r
}
async function copyStore(root:string) {
  const other=await mkdtemp(join(tmpdir(),'ih-bootstrap-cold-'));roots.push(other)
  for(const file of await readdir(root))if(file.endsWith('.jsonl')||file.endsWith('.stage')||file.endsWith('.publish'))await copyFile(join(root,file),join(other,file))
  const backend=createJsonlBackend(other),coordinator=createSessionCoordinator(backend,{lock:{enabled:true}});coordinators.push(coordinator)
  return {root:other,backend,coordinator}
}

it('creates a zero-prefix target with one real completion frame and joins same-operation reentry', async () => {
  const { root, coordinator } = await setup(), r = request()
  const [a, b] = await Promise.all([coordinator.bootstrapSemanticTarget(r, guards), coordinator.bootstrapSemanticTarget(r, guards)])
  expect(a.kind).toBe('ready'); expect(b.document).toBe(a.document)
  const raw = (await readFile(join(root, 'target.jsonl'), 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line))
  expect(raw[0].semanticSeed.seedLength).toBe(0)
  expect(raw[1]).toMatchObject({ batchId: 'bootstrap:operation:complete', firstSeq: 0, count: 1 })
  expect(await coordinator.inspectBootstrap(r.invocation)).toMatchObject({ kind: 'ready', needsConfirmation: true })
  const adopted = await coordinator.resumeSemanticTarget(r.invocation, guards)
  expect(adopted.kind).toBe('already-ready'); expect(adopted.receipt.completion.key).toEqual(a.receipt.completion.key)
})
it('refuses an already-open ordinary empty target and nonempty no-turn target without changing bytes', async () => {
  const { root, coordinator } = await setup(), r = request()
  await coordinator.create({ sessionId: 'target', createdAt: r.invocation.createdAt })
  await coordinator.openManagedDocument('target')
  const before = await readFile(join(root, 'target.jsonl'))
  expect(await coordinator.bootstrapSemanticTarget(r, guards)).toMatchObject({ kind: 'refused', reason: 'cached-unprepared' })
  expect(await readFile(join(root, 'target.jsonl'))).toEqual(before)
})
it('reserves an exact uncached existing-empty target and preserves unrelated raw metadata',async()=>{
  const {root,backend,coordinator}=await setup(),r:any=request()
  await coordinator.create({sessionId:'target',createdAt:r.invocation.createdAt})
  const path=join(root,'target.jsonl'),raw=JSON.parse(await readFile(path,'utf8'));raw.extension={original:'preserved'}
  const before=JSON.stringify(raw)+'\n';await writeFile(path,before)
  r.target={kind:'existing-empty',expectedHeaderDigest:createHash('sha256').update(before).digest('hex'),expectedPrefix:{eventCount:0,bodyBytes:0,prefixDigest:legacyPrefixDigest(0,new Uint8Array())}}
  expect(await coordinator.bootstrapSemanticTarget(r,guards)).toMatchObject({kind:'ready'})
  expect(JSON.parse((await readFile(path,'utf8')).split('\n')[0]!)).toMatchObject({extension:{original:'preserved'},title:'original'})
  expect((await backend.read('target')).events).toHaveLength(1)
})
it('keeps the original manifest ready after mutable metadata edits and a later complete live suffix',async()=>{
  const {root,coordinator}=await setup(),r=seeded(true)
  const first=await coordinator.bootstrapSemanticTarget(r,guards);expect(first.kind).toBe('ready')
  await first.document.metadata.admit({type:'plan/mode',mode:'on'})
  await coordinator.updateMeta('target',{title:'renamed',archived:true,workspaceId:'new',modelSelection:{provider:'test',model:'new'}})
  await coordinator.close()
  const cold=createSessionCoordinator(createJsonlBackend(root),{lock:{enabled:true}});coordinators.push(cold)
  const adopted=await cold.resumeSemanticTarget(r.invocation,guards)
  expect(adopted.kind).toBe('already-ready')
  if(adopted.kind!=='already-ready')throw new Error(JSON.stringify(adopted))
  expect(adopted.receipt.completion.key).toEqual(first.receipt.completion.key)
  expect(adopted.receipt.completion.owner.incarnation).not.toBe(first.receipt.completion.owner.incarnation)
  expect(adopted.document.view.events.filter((e:{type:string})=>e.type==='agent/input/admitted')).toHaveLength(1)
  expect(adopted.document.view.events.at(-1)).toMatchObject({type:'plan/mode',mode:'on'})
  expect(JSON.parse((await readFile(join(root,'target.jsonl'),'utf8')).split('\n')[0]!)).toMatchObject({title:'renamed',workspaceId:'new',archived:true})
})
it.each(['seed','complete'])('reconciles a real synced %s frame after response loss without duplicate inputs or a second view',async phase=>{
  const {root,coordinator,hooks}=await setup(),r=seeded(true)
  hooks.append=async(actual,...args)=>{const result=await actual(...args);return args[3].key.batchId.endsWith(':'+phase)?{kind:'unknown',key:args[3].key}:result}
  const lost=await coordinator.bootstrapSemanticTarget(r,guards);expect(lost).toMatchObject({kind:'blocked'})
  await expect(coordinator.openManagedDocument('target')).rejects.toMatchObject({code:'FACT_RECOVERY_REQUIRED'})
  await expect(coordinator.snapshot('target')).rejects.toMatchObject({code:'FACT_RECOVERY_REQUIRED'})
  await expect(coordinator.close()).rejects.toThrow()
  hooks.append=undefined
  // Closing revoked optional new work; original passive reconciliation is still permitted.
  const adopted=await coordinator.resumeSemanticTarget(r.invocation,guards)
  if(phase==='complete')expect(adopted.kind).toBe('already-ready')
  else expect(adopted).toMatchObject({kind:'blocked'})
  const raw=await readFile(join(root,'target.jsonl'),'utf8')
  expect(raw.match(/"batchId":"bootstrap:operation:seed"/g)).toHaveLength(1)
  const cold=await copyStore(root)
  const recovered=await cold.coordinator.resumeSemanticTarget(r.invocation,guards,r)
  expect(['ready','already-ready']).toContain(recovered.kind)
  if(recovered.kind!=='ready'&&recovered.kind!=='already-ready')throw new Error(JSON.stringify(recovered))
  expect(recovered.document.view.events.filter((e:{type:string})=>e.type==='agent/input/admitted')).toHaveLength(1)
})
it('retains a partial stage under failed close and honestly resumes cold with original payload',async()=>{
  const {root,coordinator}=await setup(),r=request(),native=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  let cut=true
  vi.mocked(open).mockImplementation(async(...args)=>{
    const h=await native.open(...args)
    if(!String(args[0]).endsWith('.stage'))return h
    return new Proxy(h,{get(target,name){
      if(name==='write')return async(buffer:Uint8Array,offset:number,length:number,position:number)=>{if(cut){cut=false;await target.write(buffer,offset,17,position);throw new Error('partial stage cut')}return target.write(buffer,offset,length,position)}
      const value=Reflect.get(target,name);return typeof value==='function'?value.bind(target):value
    }})
  })
  try {
    expect(await coordinator.bootstrapSemanticTarget(r,guards)).toMatchObject({kind:'blocked',token:{phase:'header'}})
    await expect(coordinator.openManagedDocument('target')).rejects.toMatchObject({code:'FACT_RECOVERY_REQUIRED'})
    await expect(coordinator.close()).rejects.toThrow()
    vi.mocked(open).mockImplementation(native.open)
    const cold=await copyStore(root)
    const files=await readdir(cold.root),stage=files.find(f=>f.endsWith('.stage'))!,before=await readFile(join(cold.root,stage))
    expect(before).toHaveLength(17)
    expect(await cold.coordinator.inspectBootstrap(r.invocation)).toMatchObject({kind:'unavailable',token:{manifest:'unknown'}})
    expect(await cold.coordinator.resumeSemanticTarget(r.invocation,guards)).toMatchObject({kind:'blocked',reason:'payload-required',token:{manifest:'unknown'}})
    await expect(cold.coordinator.create({sessionId:'target'})).rejects.toThrow()
    expect(await readFile(join(cold.root,stage))).toEqual(before)
    const resumed=await cold.coordinator.resumeSemanticTarget(r.invocation,guards,r)
    expect(resumed.kind).toBe('ready')
    expect((await readFile(join(cold.root,stage))).subarray(0,17)).toEqual(before)
    await coordinator.resumeSemanticTarget(r.invocation,guards,r)
  }finally{vi.mocked(open).mockImplementation(native.open)}
})
it('blocks cold public open and metadata mutations when existing-empty publication has not occurred',async()=>{
  const {root,backend,coordinator}=await setup(),r:any=request()
  await coordinator.create({sessionId:'target',createdAt:r.invocation.createdAt})
  const path=join(root,'target.jsonl'),raw=await readFile(path)
  r.target={kind:'existing-empty',expectedHeaderDigest:createHash('sha256').update(raw).digest('hex'),expectedPrefix:{eventCount:0,bodyBytes:0,prefixDigest:legacyPrefixDigest(0,new Uint8Array())}}
  const actual=backend.prepareBootstrapHeader!
  backend.prepareBootstrapHeader=async(_id,owner,operation)=>{owner.beforeIssue();const key=createHash('sha256').update((await import('@i-harness/core-session')).canonicalJsonData(operation.invocation)).digest('hex');await writeFile(path+'.bootstrap-'+key+'.stage',operation.stageBytes);return {kind:'unknown'}}
  expect(await coordinator.bootstrapSemanticTarget(r,guards)).toMatchObject({kind:'blocked'})
  const cold=await copyStore(root)
  await expect(cold.coordinator.openManagedDocument('target')).rejects.toThrow()
  await expect(cold.coordinator.updateMeta('target',{title:'hijack'})).rejects.toThrow()
  await expect(cold.coordinator.append('target',[{type:'plan/mode',mode:'on'}])).rejects.toThrow()
  expect(await readFile(join(cold.root,'target.jsonl'))).toEqual(raw)
  backend.prepareBootstrapHeader=actual
})
it('does not repair a later torn suffix during ready adoption',async()=>{
  const {root,coordinator}=await setup(),r=request()
  expect((await coordinator.bootstrapSemanticTarget(r,guards)).kind).toBe('ready')
  await coordinator.close()
  const path=join(root,'target.jsonl'),before=Buffer.concat([await readFile(path),Buffer.from('{"recordKind":"torn')]);await writeFile(path,before)
  const cold=createSessionCoordinator(createJsonlBackend(root),{lock:{enabled:true}});coordinators.push(cold)
  expect(await cold.resumeSemanticTarget(r.invocation,guards)).toMatchObject({kind:'blocked'})
  expect(await readFile(path)).toEqual(before)
})
it('refuses changed original materialization and invalid operation IDs before file work',async()=>{
  const {root,coordinator}=await setup(),r:any=request()
  expect((await coordinator.bootstrapSemanticTarget(r,guards)).kind).toBe('ready')
  expect(await coordinator.bootstrapSemanticTarget({...r,metadata:{title:'other'}},guards)).toMatchObject({kind:'refused',reason:'conflict'})
  for(const operationId of ['x'.repeat(238),'space id','é'])expect(await coordinator.bootstrapSemanticTarget({...r,invocation:{...r.invocation,operationId,targetSessionId:'invalid'}},guards)).toMatchObject({kind:'refused',reason:'manifest-invalid'})
  expect(await readdir(root)).not.toContain('invalid.jsonl')
})
it('includes exact original and partial staging artifacts in owned deletion and fences resume by tombstone',async()=>{
  const {root,backend,coordinator}=await setup(),r=request()
  expect((await coordinator.bootstrapSemanticTarget(r,guards)).kind).toBe('ready')
  await coordinator.close()
  const partial='target.jsonl.bootstrap-'+'f'.repeat(64)+'.stage'
  await writeFile(join(root,partial),'partial original header operation')
  const stages=(await readdir(root)).filter(n=>n.endsWith('.stage'))
  await backend.deleteOwnedSession!('target',{documents:[]})
  for(const file of stages)expect(await readdir(root)).not.toContain(file)
  const receipt=await backend.deletionReceipt!('target')
  expect(receipt!.manifest.files).toEqual(stages.sort())
  const cold=createSessionCoordinator(backend,{lock:{enabled:true}});coordinators.push(cold)
  const resumed=await cold.resumeSemanticTarget(r.invocation,guards,r)
  expect(resumed.kind).toBe('refused')
  expect(await readdir(root)).not.toContain('target.jsonl')
})
it('refuses metadata-only nonempty targets and a stale source before reservation',async()=>{
  const {root,coordinator}=await setup(),r=request()
  await coordinator.create({sessionId:'target',createdAt:r.invocation.createdAt})
  await coordinator.append('target',[{type:'plan/mode',mode:'on'}])
  const before=await readFile(join(root,'target.jsonl'))
  expect(await coordinator.bootstrapSemanticTarget(r,guards)).toMatchObject({kind:'refused',reason:'nonempty'})
  expect(await readFile(join(root,'target.jsonl'))).toEqual(before)
  const other={...r,invocation:{...r.invocation,targetSessionId:'stale'}}
  expect(await coordinator.bootstrapSemanticTarget(other,{...guards,assertCurrent(){throw new Error('source changed')}})).toMatchObject({kind:'not-issued',reason:'stale-source'})
  expect((await readdir(root)).some(n=>n.startsWith('stale.jsonl'))).toBe(false)
})
it('preserves the reserved source and clocks when source changes after real seed sync',async()=>{
  const {root,coordinator,hooks}=await setup(),r=seeded(true)
  let fresh=true
  hooks.append=async(actual,...args)=>{const result=await actual(...args);if(args[3].key.batchId.endsWith(':seed'))fresh=false;return result}
  expect(await coordinator.bootstrapSemanticTarget(r,{...guards,assertCurrent(){if(!fresh)throw new Error('changed source')}})).toMatchObject({kind:'blocked',reason:'source-changed'})
  const raw=await readFile(join(root,'target.jsonl'),'utf8')
  expect(raw).toContain('original source');expect(raw).not.toContain('"type":"session/bootstrap"')
  hooks.append=undefined
  const recovered=await coordinator.resumeSemanticTarget(r.invocation,guards,r)
  expect(recovered.kind).toBe('ready')
  if(recovered.kind==='ready')expect(recovered.receipt.initial).toMatchObject({inputId:'initial',startedAt:100,expiresAt:200})
})
it('rechecks Stop after stage sync and keeps inspection read-only',async()=>{
  const {root,coordinator}=await setup(),r=request(),controller=new AbortController(),native=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  let syncs=0,writes=0
  vi.mocked(open).mockImplementation(async(...args)=>{const h=await native.open(...args);return new Proxy(h,{get(target,name){
    if(name==='sync')return async()=>{syncs++;await target.sync();if(String(args[0]).endsWith('.stage'))controller.abort()}
    if(name==='write')return async(...values:Parameters<typeof target.write>)=>{writes++;return (target.write as Function)(...values)}
    const value=Reflect.get(target,name);return typeof value==='function'?value.bind(target):value
  }})})
  try {
    expect(await coordinator.bootstrapSemanticTarget(r,{...guards,signal:controller.signal})).toMatchObject({kind:'blocked',token:{phase:'header'}})
    expect(await readdir(root)).not.toContain('target.jsonl')
    const counters=[syncs,writes]
    expect(await coordinator.inspectBootstrap(r.invocation)).toMatchObject({kind:'reserved'})
    expect([syncs,writes]).toEqual(counters)
  }finally{vi.mocked(open).mockImplementation(native.open)}
})
it.each(['stage','target'])('completes actual short writes for %s header bytes',async which=>{
  const {root,coordinator}=await setup(),r=request(),native=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  let shorts=0
  vi.mocked(open).mockImplementation(async(...args)=>{const h=await native.open(...args)
    if(which==='stage'?!String(args[0]).endsWith('.stage'):String(args[0])!==join(root,'target.jsonl')||args[1]!=='wx')return h
    return new Proxy(h,{get(target,name){if(name==='write')return async(buffer:Uint8Array,offset:number,length:number,position:number)=>{shorts++;return target.write(buffer,offset,Math.min(11,length),position)};const value=Reflect.get(target,name);return typeof value==='function'?value.bind(target):value}})
  })
  try{expect((await coordinator.bootstrapSemanticTarget(r,guards)).kind).toBe('ready');expect(shorts).toBeGreaterThan(2);expect((await coordinator.openManagedDocument('target')).view.events).toHaveLength(1)}finally{vi.mocked(open).mockImplementation(native.open)}
})
it('continues only original matching partial target header bytes without truncation',async()=>{
  const {root,coordinator}=await setup(),r=request(),native=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  let cut=true;const truncates:number[]=[]
  vi.mocked(open).mockImplementation(async(...args)=>{const h=await native.open(...args);if(String(args[0])!==join(root,'target.jsonl'))return h
    return new Proxy(h,{get(target,name){
      if(name==='write')return async(buffer:Uint8Array,offset:number,length:number,position:number)=>{if(cut&&args[1]==='wx'){cut=false;await target.write(buffer,offset,13,position);throw new Error('partial target')}return target.write(buffer,offset,length,position)}
      if(name==='truncate')return async(length:number)=>{truncates.push(length);return target.truncate(length)}
      const value=Reflect.get(target,name);return typeof value==='function'?value.bind(target):value
    }})})
  try{
    expect(await coordinator.bootstrapSemanticTarget(r,guards)).toMatchObject({kind:'blocked'})
    const before=await readFile(join(root,'target.jsonl'));expect(before).toHaveLength(13)
    expect((await coordinator.resumeSemanticTarget(r.invocation,guards,r)).kind).toBe('ready')
    expect((await readFile(join(root,'target.jsonl'))).subarray(0,13)).toEqual(before)
    // Journal absence confirmation may truncate an empty suffix; the header
    // operation itself completed before that separate qualified batch step.
  }finally{vi.mocked(open).mockImplementation(native.open)}
  const final=await readFile(join(root,'target.jsonl'));expect(truncates.every(n=>n>=final.indexOf(10)+1)).toBe(true)
})
it('retains a synced deterministic frame through installation failure and installs once on reconcile',async()=>{
  const {root,coordinator}=await setup(),r=seeded(true)
  installCut.enabled=true
  expect(await coordinator.bootstrapSemanticTarget(r,guards)).toMatchObject({kind:'blocked'})
  expect((await readFile(join(root,'target.jsonl'),'utf8')).match(/"batchId":"bootstrap:operation:seed"/g)).toHaveLength(1)
  const recovered=await coordinator.resumeSemanticTarget(r.invocation,guards,r)
  expect(recovered.kind).toBe('ready')
  if(recovered.kind==='ready')expect(recovered.document.view.events.filter((e:{type:string})=>e.type==='agent/input/admitted')).toHaveLength(1)
})
it('reconciles matching partial seed only through the original journal absence proof',async()=>{
  const {root,coordinator}=await setup(),r=seeded(),native=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  let failed=false
  vi.mocked(open).mockImplementation(async(...args)=>{const h=await native.open(...args);if(String(args[0])!==join(root,'target.jsonl')||args[1]!=='r+')return h
    return new Proxy(h,{get(target,name){
      if(name==='write')return async(buffer:Uint8Array,offset:number,length:number,position:number)=>{if(Buffer.from(buffer).toString().includes('bootstrap:operation:seed')){failed=true;await target.write(buffer,offset,29,position);throw new Error('partial seed')}return target.write(buffer,offset,length,position)}
      if(name==='truncate'||name==='sync')return async()=>{if(failed)throw new Error('absence proof unavailable');return name==='sync'?target.sync():target.truncate()}
      const value=Reflect.get(target,name);return typeof value==='function'?value.bind(target):value
    }})})
  try{expect(await coordinator.bootstrapSemanticTarget(r,guards)).toMatchObject({kind:'blocked'});expect((await readFile(join(root,'target.jsonl'),'utf8')).endsWith('\n')).toBe(false)}finally{vi.mocked(open).mockImplementation(native.open)}
  expect((await coordinator.resumeSemanticTarget(r.invocation,guards,r)).kind).toBe('ready')
  expect((await readFile(join(root,'target.jsonl'),'utf8')).match(/"batchId":"bootstrap:operation:seed"/g)).toHaveLength(1)
})
it('adopts an existing-empty rename whose response was lost',async()=>{
  const {root,coordinator}=await setup(),r:any=request(),native=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  await coordinator.create({sessionId:'target',createdAt:r.invocation.createdAt});const before=await readFile(join(root,'target.jsonl'))
  r.target={kind:'existing-empty',expectedHeaderDigest:createHash('sha256').update(before).digest('hex'),expectedPrefix:{eventCount:0,bodyBytes:0,prefixDigest:legacyPrefixDigest(0,new Uint8Array())}}
  vi.mocked(rename).mockImplementation(async(...args)=>{await native.rename(...args);if(String(args[0]).endsWith('.publish'))throw new Error('rename caller response lost')})
  try{expect(await coordinator.bootstrapSemanticTarget(r,guards)).toMatchObject({kind:'blocked'})}finally{vi.mocked(rename).mockImplementation(native.rename)}
  expect((await coordinator.resumeSemanticTarget(r.invocation,guards,r)).kind).toBe('ready')
})
it('uses the maximum printable operation ID without exceeding the real frame encoder bound',async()=>{
  const {root,coordinator}=await setup(),r=request();r.invocation.operationId='x'.repeat(237)
  expect((await coordinator.bootstrapSemanticTarget(r,guards)).kind).toBe('ready')
  const lines=(await readFile(join(root,'target.jsonl'),'utf8')).trimEnd().split('\n')
  expect(JSON.parse(lines[1]!).batchId).toHaveLength(256)
})
it('waits for the exact injected dependency operation and passively checks its stored closure on reentry',async()=>{
  const {root,coordinator}=await setup(),r=dependent(),gate=Promise.withResolvers<void>(),reached=Promise.withResolvers<void>(),closure='c'.repeat(64)
  const captured:persistence.BootstrapDependencyRequest[]=[]
  const g:persistence.BootstrapGuards={assertCurrent(){},dependencies:{async confirm(value){captured.push(value);reached.resolve();await gate.promise;return {kind:'confirmed',closureDigest:closure}},async reconcile(value){captured.push(value);return {kind:'confirmed',closureDigest:closure}}}}
  const pending=coordinator.bootstrapSemanticTarget(r,g);await reached.promise
  const before=await readFile(join(root,'target.jsonl'),'utf8');expect(before.trimEnd().split('\n')).toHaveLength(1)
  await expect(coordinator.openManagedDocument('target')).rejects.toThrow()
  gate.resolve();const ready=await pending;expect(ready.kind).toBe('ready')
  expect(captured[0]).toMatchObject({operationId:'operation',sourceSessionId:'parent',targetSessionId:'target',artifacts:[{ref:{id:'ctxv1_'+'c'.repeat(64)}}]})
  expect(await coordinator.resumeSemanticTarget(r.invocation,{...g,dependencies:{...g.dependencies,async reconcile(){return {kind:'confirmed',closureDigest:'f'.repeat(64)}}}})).toMatchObject({kind:'blocked',reason:'dependency-unavailable'})
  expect((await coordinator.resumeSemanticTarget(r.invocation,g)).kind).toBe('already-ready')
})
it('refuses anonymous artifact authority and stale source after dependency await without seed bytes',async()=>{
  const {root,coordinator}=await setup(),anonymous=dependent(true)
  expect(await coordinator.bootstrapSemanticTarget(anonymous,guards)).toMatchObject({kind:'refused',reason:'target-policy'})
  expect(await readdir(root)).not.toContain('target.jsonl')
  const r=dependent();let fresh=true
  const g:persistence.BootstrapGuards={assertCurrent(){if(!fresh)throw new Error('source changed')},dependencies:{async confirm(){fresh=false;return {kind:'confirmed',closureDigest:'c'.repeat(64)}},async reconcile(){return {kind:'blocked',reason:'unavailable'}}}}
  expect(await coordinator.bootstrapSemanticTarget(r,g)).toMatchObject({kind:'blocked',reason:'source-changed'})
  expect((await readFile(join(root,'target.jsonl'),'utf8')).trimEnd().split('\n')).toHaveLength(1)
})
it('binds the actual original stage metadata and compiled records in a noncircular manifest',async()=>{
  const {root,coordinator}=await setup(),r=seeded(true)
  expect((await coordinator.bootstrapSemanticTarget(r,guards)).kind).toBe('ready')
  const filename=(await readdir(root)).find(n=>n.endsWith('.stage'))!,stage=JSON.parse(await readFile(join(root,filename),'utf8'))
  const {canonicalJsonData}=await import('@i-harness/core-session')
  const preimage={version:1,invocation:stage.invocation,target:stage.originalTarget,metadata:stage.metadata,lineage:stage.lineage,headerBase:stage.headerBase,
    seed:{digest:stage.seed.digest,dependencyDigest:stage.seed.dependencyDigest,sourceObservation:stage.seed.sourceObservation,records:r.seed.records},initial:stage.initial}
  const expected=createHash('sha256').update('ih.bootstrap.manifest.v1\0'+canonicalJsonData(preimage)).digest('hex')
  expect(JSON.parse(stage.headerBytes).semanticSeed.manifestDigest).toBe(expected)
  expect(stage).not.toHaveProperty('records');expect(JSON.stringify(stage)).not.toContain('do task once');expect(JSON.stringify(stage)).not.toContain('original source')
  const changed=structuredClone(r);changed.initial.text='a different task'
  expect(await coordinator.bootstrapSemanticTarget(changed,guards)).toMatchObject({kind:'refused',reason:'conflict'})
})
it('rejects callbacks and mismatched compiled source binding before any reservation write',async()=>{
  const {root,coordinator}=await setup(),r=seeded();let calls=0
  Object.defineProperty(r.metadata,'title',{enumerable:true,get(){calls++;return 'mutable title'}})
  expect(await coordinator.bootstrapSemanticTarget(r,guards)).toMatchObject({kind:'refused',reason:'manifest-invalid'})
  expect(calls).toBe(0)
  const broken=seeded();broken.seed.sourceObservation.digest='f'.repeat(64)
  expect(await coordinator.bootstrapSemanticTarget(broken,guards)).toMatchObject({kind:'refused',reason:'manifest-invalid'})
  expect((await readdir(root)).some(n=>n.startsWith('target.jsonl'))).toBe(false)
})
it('passively confirms complete header bytes after sync failure while Stop prevents the next phase',async()=>{
  const {root,coordinator}=await setup(),r=request(),native=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(open).mockImplementation(async(...args)=>{const h=await native.open(...args)
    if(String(args[0])!==join(root,'target.jsonl')||args[1]!=='wx')return h
    return new Proxy(h,{get(target,name){if(name==='sync')return async()=>{throw new Error('target sync cut')};const value=Reflect.get(target,name);return typeof value==='function'?value.bind(target):value}})
  })
  try{expect(await coordinator.bootstrapSemanticTarget(r,guards)).toMatchObject({kind:'blocked'})}finally{vi.mocked(open).mockImplementation(native.open)}
  const controller=new AbortController();controller.abort()
  expect(await coordinator.resumeSemanticTarget(r.invocation,{...guards,signal:controller.signal})).toMatchObject({kind:'blocked'})
  expect((await readFile(join(root,'target.jsonl'),'utf8')).trimEnd().split('\n')).toHaveLength(1)
  expect((await coordinator.resumeSemanticTarget(r.invocation,guards)).kind).toBe('ready')
})
it('keeps header fsync commitment when file close cleanup fails',async()=>{
  const {root,coordinator}=await setup(),r=request(),native=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(open).mockImplementation(async(...args)=>{const h=await native.open(...args)
    if(args[1]!=='wx')return h
    return new Proxy(h,{get(target,name){if(name==='close')return async()=>{await target.close();throw new Error('close after sync')};const value=Reflect.get(target,name);return typeof value==='function'?value.bind(target):value}})
  })
  try{expect((await coordinator.bootstrapSemanticTarget(r,guards)).kind).toBe('ready')}finally{vi.mocked(open).mockImplementation(native.open)}
  expect((await readFile(join(root,'target.jsonl'),'utf8')).match(/"batchId":"bootstrap:operation:complete"/g)).toHaveLength(1)
})
it('rejects a foreign historical receipt after real sync and adopts only the current owner evidence',async()=>{
  const {root,coordinator,hooks}=await setup(),r=request()
  hooks.confirm=async(actual,...args)=>{const result=await actual(...args);return result.kind==='committed'?{...result,receipts:result.receipts.map((receipt:any)=>({...receipt,owner:{...receipt.owner,sessionId:'foreign'}}))}:result}
  expect(await coordinator.bootstrapSemanticTarget(r,guards)).toMatchObject({kind:'blocked'})
  await expect(coordinator.openManagedDocument('target')).rejects.toThrow()
  const before=await readFile(join(root,'target.jsonl'))
  hooks.confirm=undefined
  expect((await coordinator.resumeSemanticTarget(r.invocation,guards)).kind).toBe('already-ready')
  expect(await readFile(join(root,'target.jsonl'))).toEqual(before)
})
it('refuses a pending write-behind before bootstrap opening and preserves its accepted drain',async()=>{
  const {root,coordinator}=await setup(),r=request()
  await coordinator.create({sessionId:'target',createdAt:r.invocation.createdAt})
  coordinator.enqueue('target',[{type:'plan/mode',mode:'on'}])
  expect(await coordinator.bootstrapSemanticTarget(r,guards)).toMatchObject({kind:'refused',reason:'cached-unprepared'})
  await coordinator.flush('target')
  expect((await readdir(root)).some(n=>n.endsWith('.stage'))).toBe(false)
  expect((await coordinator.snapshot('target')).session.events).toEqual([{type:'plan/mode',mode:'on',seq:0}])
})
it('review F1 preserves actual seed/completion/initial frames through same-events and allowed suffix replacement',async()=>{
  const {root,backend,coordinator}=await setup(),r=seeded(true)
  const ready=await coordinator.bootstrapSemanticTarget(r,guards);expect(ready.kind).toBe('ready')
  await ready.document.metadata.admit({type:'plan/mode',mode:'on'})
  await coordinator.close()
  const path=join(root,'target.jsonl'),before=await readFile(path),lines=before.toString('utf8').split('\n')
  const actualBirth=Buffer.from(lines.slice(0,3).join('\n')+'\n')
  const loaded=await backend.read('target')
  await backend.replaceEvents!('target',loaded.events)
  expect((await readFile(path)).subarray(0,actualBirth.length)).toEqual(actualBirth)
  expect((await backend.read('target')).events).toEqual(loaded.events)
  const changed=structuredClone(loaded.events);changed[changed.length-1]={type:'plan/mode',mode:'off',seq:changed.length-1}
  await backend.replaceEvents!('target',changed)
  expect((await readFile(path)).subarray(0,actualBirth.length)).toEqual(actualBirth)
  expect((await backend.read('target')).events).toEqual(changed)
  await backend.updateMeta('target',{title:'after allowed replacement'})
  const cold=createSessionCoordinator(backend,{lock:{enabled:true}});coordinators.push(cold)
  const adopted=await cold.resumeSemanticTarget(r.invocation,guards)
  expect(adopted.kind).toBe('already-ready')
  if(adopted.kind==='already-ready') {
    expect(adopted.receipt.seed!.key).toEqual(ready.receipt.seed.key)
    expect(adopted.receipt.completion.key).toEqual(ready.receipt.completion.key)
    expect(adopted.document.view.events.filter(e=>e.type==='agent/input/admitted')).toHaveLength(1)
    expect(adopted.document.view.events.at(-1)).toMatchObject({type:'plan/mode',mode:'off'})
  }
})
it('review F1 refuses changed or malformed original birth before replacing any bytes',async()=>{
  const {root,backend,coordinator}=await setup(),r=seeded(true)
  expect((await coordinator.bootstrapSemanticTarget(r,guards)).kind).toBe('ready');await coordinator.close()
  const path=join(root,'target.jsonl'),before=await readFile(path),loaded=await backend.read('target')
  const changed=structuredClone(loaded.events),completion=changed.find(e=>e.type==='session/bootstrap')!
  if(completion.type!=='session/bootstrap')throw new Error('missing completion')
  completion.dependencyClosureDigest='f'.repeat(64)
  await expect(backend.replaceEvents!('target',changed)).rejects.toThrow()
  expect(await readFile(path)).toEqual(before)
  await expect(backend.replaceEvents!('target',loaded.events.filter(e=>e.type!=='agent/input/admitted'))).rejects.toThrow()
  expect(await readFile(path)).toEqual(before)
  const {encodeFactBatch}=await import('@i-harness/core-session'),end=before.indexOf(10),header=JSON.parse(before.subarray(0,end).toString())
  const foreign=Buffer.concat([before.subarray(0,end+1),Buffer.from(encodeFactBatch('foreign-whole-birth',header.journal.legacyPrefixDigest,loaded.events).bytes)])
  await writeFile(path,foreign)
  await expect(backend.replaceEvents!('target',loaded.events)).rejects.toThrow()
  expect(await readFile(path)).toEqual(foreign)
})
it('review F1 preserves a zero-seed completion frame across ordinary replacement',async()=>{
  const {root,backend,coordinator}=await setup(),r=request()
  const ready=await coordinator.bootstrapSemanticTarget(r,guards);expect(ready.kind).toBe('ready');await coordinator.close()
  const path=join(root,'target.jsonl'),before=await readFile(path),loaded=await backend.read('target')
  await backend.replaceEvents!('target',loaded.events)
  expect(await readFile(path)).toEqual(before)
  expect((await backend.read('target')).events).toEqual(loaded.events)
  const cold=createSessionCoordinator(backend,{lock:{enabled:true}});coordinators.push(cold)
  const adopted=await cold.resumeSemanticTarget(r.invocation,guards)
  expect(adopted.kind).toBe('already-ready')
  if(adopted.kind==='already-ready')expect(adopted.receipt.completion.key).toEqual(ready.receipt.completion.key)
})
it.each([['stage','stale'],['stage','abort'],['target','stale'],['target','abort']] as const)('review F2 stops %s short-write continuation at %s and resumes only under a fresh guard',async(which,mode)=>{
  const {root,coordinator}=await setup(),r=request(),native=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises'),controller=new AbortController()
  let fresh=true,flipped=false,selectedWrites=0,afterFlipWrites=0
  vi.mocked(open).mockImplementation(async(...args)=>{const h=await native.open(...args)
    if(which==='stage'?!String(args[0]).endsWith('.stage'):String(args[0])!==join(root,'target.jsonl'))return h
    return new Proxy(h,{get(target,name){
      if(name==='write')return async(buffer:Uint8Array,offset:number,length:number,position:number)=>{
        if(flipped)afterFlipWrites++;selectedWrites++
        const result=await target.write(buffer,offset,Math.min(11,length),position)
        if(!flipped){flipped=true;if(mode==='stale')fresh=false;else controller.abort()}
        return result
      }
      const value=Reflect.get(target,name);return typeof value==='function'?value.bind(target):value
    }})
  })
  const stopped={...guards,signal:controller.signal,assertCurrent(){if(!fresh)throw new Error('source changed during short write')}}
  try {
    const initial=await coordinator.bootstrapSemanticTarget(r,stopped)
    expect(initial).toMatchObject({kind:'blocked'})
    expect(selectedWrites).toBe(1);expect(afterFlipWrites).toBe(0)
    expect(initial).toMatchObject({token:{phase:'header'}})
    const selected=which==='stage'?(await readdir(root)).find(n=>n.endsWith('.stage'))!:'target.jsonl',before=await readFile(join(root,selected))
    expect(before).toHaveLength(11)
    expect(await coordinator.resumeSemanticTarget(r.invocation,stopped,r)).toMatchObject({kind:'blocked'})
    expect(selectedWrites).toBe(1);expect(afterFlipWrites).toBe(0)
    expect(await readFile(join(root,selected))).toEqual(before)
  }finally{vi.mocked(open).mockImplementation(native.open)}
  expect((await coordinator.resumeSemanticTarget(r.invocation,guards,r)).kind).toBe('ready')
})
it('review F3 retains matching publication-only uncertainty and refuses new-target work around its bytes',async()=>{
  const {root,coordinator}=await setup(),r=request(),{canonicalJsonData}=await import('@i-harness/core-session')
  const key=createHash('sha256').update(canonicalJsonData(r.invocation)).digest('hex'),name='target.jsonl.bootstrap-'+key+'.publish',partial=Buffer.from('partial-publication')
  await writeFile(join(root,name),partial)
  expect(await coordinator.inspectBootstrap(r.invocation)).toMatchObject({kind:'unavailable',needsConfirmation:true,token:{phase:'header',manifest:'unknown'}})
  const result=await coordinator.bootstrapSemanticTarget(r,guards)
  expect(['blocked','refused']).toContain(result.kind)
  expect(await readdir(root)).toContain(name)
  expect((await readdir(root)).some(n=>n==='target.jsonl'||n.endsWith('.stage'))).toBe(false)
  expect(await readFile(join(root,name))).toEqual(partial)
})
it.each(['matching','foreign'] as const)('review F3 checks %s retained existing-empty publication bytes before continuation',async kind=>{
  const {root,backend,coordinator}=await setup(),r=request(),native=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  await coordinator.create({sessionId:'target',createdAt:r.invocation.createdAt})
  const path=join(root,'target.jsonl'),original=await readFile(path)
  r.target={kind:'existing-empty',expectedHeaderDigest:createHash('sha256').update(original).digest('hex'),expectedPrefix:{eventCount:0,bodyBytes:0,prefixDigest:legacyPrefixDigest(0,new Uint8Array())}}
  vi.mocked(open).mockImplementation(async(...args)=>{const h=await native.open(...args);if(!String(args[0]).endsWith('.publish'))return h
    return new Proxy(h,{get(target,name){if(name==='write')return async(buffer:Uint8Array,offset:number,_length:number,position:number)=>{await target.write(buffer,offset,13,position);throw new Error('publication partial write')};const value=Reflect.get(target,name);return typeof value==='function'?value.bind(target):value}})
  })
  try{expect(await coordinator.bootstrapSemanticTarget(r,guards)).toMatchObject({kind:'blocked'})}finally{vi.mocked(open).mockImplementation(native.open)}
  const publication=(await readdir(root)).find(n=>n.endsWith('.publish'))!,stage=(await readdir(root)).find(n=>n.endsWith('.stage'))!
  expect(await readFile(path)).toEqual(original)
  if(kind==='foreign') {
    await writeFile(join(root,publication),'FOREIGN publication')
    const beforePublication=await readFile(join(root,publication)),beforeStage=await readFile(join(root,stage))
    expect(await coordinator.inspectBootstrap(r.invocation)).toMatchObject({kind:'conflict',needsConfirmation:true})
    expect(await coordinator.resumeSemanticTarget(r.invocation,guards,r)).toMatchObject({kind:'refused',reason:'conflict'})
    expect(await readFile(path)).toEqual(original);expect(await readFile(join(root,publication))).toEqual(beforePublication);expect(await readFile(join(root,stage))).toEqual(beforeStage)
  } else {
    const partial=await readFile(join(root,publication));expect(partial).toHaveLength(13)
    expect(await coordinator.resumeSemanticTarget(r.invocation,{...guards,assertCurrent(){throw new Error('stale')}},r)).toMatchObject({kind:'blocked'})
    expect(await readFile(join(root,publication))).toEqual(partial)
    const cold=await copyStore(root)
    expect((await cold.coordinator.resumeSemanticTarget(r.invocation,guards,r)).kind).toBe('ready')
    expect((await coordinator.resumeSemanticTarget(r.invocation,guards,r)).kind).toBe('ready')
    expect(await readdir(root)).not.toContain(publication)
    expect((await backend.read('target')).events).toHaveLength(1)
  }
})
it('review F3 refuses conflicting retained publication during already-ready confirmation',async()=>{
  const {root,coordinator}=await setup(),r=request(),{canonicalJsonData}=await import('@i-harness/core-session')
  expect((await coordinator.bootstrapSemanticTarget(r,guards)).kind).toBe('ready')
  const key=createHash('sha256').update(canonicalJsonData(r.invocation)).digest('hex'),name='target.jsonl.bootstrap-'+key+'.publish'
  await writeFile(join(root,name),'unqualified publication')
  const before=await readFile(join(root,'target.jsonl')),publication=await readFile(join(root,name))
  expect(await coordinator.inspectBootstrap(r.invocation)).toMatchObject({kind:'conflict',needsConfirmation:true})
  expect(await coordinator.resumeSemanticTarget(r.invocation,guards)).toMatchObject({kind:'refused',reason:'conflict'})
  expect(await readFile(join(root,'target.jsonl'))).toEqual(before);expect(await readFile(join(root,name))).toEqual(publication)
})
