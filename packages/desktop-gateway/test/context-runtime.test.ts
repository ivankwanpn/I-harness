import {afterEach,expect,it,vi} from 'vitest'
import {mkdir,mkdtemp,rm,stat,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createNativeContextRuntime} from '../src/context-runtime.ts'
import {createGatewayForkFixture} from './helpers/fork-fixture.ts'
const cleanup:Array<()=>Promise<void>>=[]
afterEach(async()=>{for(const operation of cleanup.splice(0).reverse())await operation()})
async function setup(){
  // Keep SQLite journals within Windows path limits in isolated worktrees.
  const base=tmpdir()
  const root=await mkdtemp(join(base,'runtime-'));cleanup.push(()=>rm(root,{recursive:true,force:true}))
  const workspace=join(root,'repo'),storageRoot=join(root,'storage');await mkdir(workspace)
  await writeFile(join(workspace,'auth.ts'),'export function approveDeployment() { return true }')
  let roots=[workspace]
  const profiles:Record<string,{parentSession?:string}>={s:{},other:{},child:{parentSession:'s'}}
  const visibleRefs:Record<string,any[]>={child:[]}
  const runtime=await createNativeContextRuntime({workspace,storageRoot,
    coordinator:{profile:async id=>{if(!profiles[id])throw new Error('unknown');return{meta:{...profiles[id]!,formatVersion:1,sessionId:id,createdAt:new Date().toISOString()},blank:false}}},
    visibleRefsFor:async id=>visibleRefs[id]??[],
    projectFor:async()=>({projectId:'project',scope:{id:'project',name:'Project',roots,primaryRoot:roots[0]!}})})
  cleanup.push(()=>runtime.close())
  return{runtime,storageRoot,workspace,visibleRefs,move:()=>{roots=[root]}}
}
it('does not create either native store when both are disabled',async()=>{
  const{runtime,storageRoot}=await setup()
  expect(runtime.contextOutput.status().enabled).toBe(false)
  expect(runtime.codeRetrieval.status().enabled).toBe(false)
  await expect(stat(storageRoot)).rejects.toThrow()
})
it('preserves enabled ordinary output on a profile-only coordinator without ordering authority',async()=>{
  const{runtime,move}=await setup()
  await runtime.contextOutput.configure({enabled:true})
  const ref=await runtime.contextOutput.capture({sessionId:'s',callId:'generic',label:'generic',text:'ordinary captured bytes',complete:true,source:await runtime.sourceFor('s')})
  if(!ref)throw Error('Ordinary output unavailable')
  expect((await runtime.contextOutput.read({sessionId:'s'},{refId:ref.id})).text).toBe('ordinary captured bytes')
  move();await expect(runtime.contextOutput.read({sessionId:'s'},{refId:ref.id})).rejects.toThrow()
})
it('binds output references to actual session lineage and current project scope',async()=>{
  const f=await createGatewayForkFixture(),{runtime}=f
  try{
    await runtime.contextOutput.configure({enabled:true})
    const ref=await runtime.contextOutput.capture({sessionId:'source',callId:'call',label:'test',text:'captured',complete:true,source:await runtime.sourceFor('source')})
    if(!ref)throw new Error('Actual source capture refused')
    await expect(runtime.contextOutput.read({sessionId:'other'},{refId:ref.id})).rejects.toThrow()
    await expect(runtime.contextOutput.read({sessionId:'child'},{refId:ref.id})).rejects.toThrow()
    await f.coordinator.append('source',[{type:'turn/start'},{type:'user/message',text:'actual typed ref'},{type:'context/result-ref',ref},{type:'turn/end'}])
    const operation=await f.prepare('source','child','scope-positive')
    expect((await f.execute(operation)).kind).toBe('ready')
    await runtime.withLegacyReadObservation({sessionId:'child'},async observation=>{
      expect((await runtime.contextOutput.readLegacyObserved({sessionId:'child'},{refId:ref.id},observation)).text).toBe('captured')
    })
    await f.projects.revoke('p')
    await expect(runtime.contextOutput.read({sessionId:'source'},{refId:ref.id})).rejects.toThrow()
    await expect(runtime.withLegacyReadObservation({sessionId:'child'},observation=>runtime.contextOutput.readLegacyObserved({sessionId:'child'},{refId:ref.id},observation))).rejects.toThrow()
  }finally{await f.close()}
})
it('authorizes managed results with actual source metadata and denies current project revocation',async()=>{
  const{runtime,move,visibleRefs}=await setup()
  const scope=runtime.contextOutput.registerResultScope({operationId:'managed-original',sessionId:'s',callId:'call',source:await runtime.sourceFor('s')},()=>true)
  const sink=await runtime.contextOutput.beginResult(scope,'text-utf8-v1')
  await sink.write(Buffer.from('managed complete output'))
  const result=await sink.finish('complete')
  if(result.kind!=='committed')throw new Error('Expected managed source fixture')
  expect((await runtime.contextOutput.readResult({sessionId:'s'},{ref:result.ref})).data).toEqual({kind:'text',text:'managed complete output'})
  visibleRefs.child=[result.ref]
  await expect(runtime.contextOutput.readResult({sessionId:'child'},{ref:result.ref})).rejects.toThrow(/unauthorized/)
  move()
  await expect(runtime.contextOutput.readResult({sessionId:'s'},{ref:result.ref})).rejects.toThrow(/unauthorized/)
})
it('indexes human-selected source roots and rejects hits after current membership changes',async()=>{
  const{runtime,move}=await setup();await runtime.codeRetrieval.configure({enabled:true})
  const{jobId}=await runtime.codeRetrieval.startIndex({sessionId:runtime.humanSessionId});await runtime.codeRetrieval.wait(jobId)
  const hits=await runtime.codeRetrieval.search({sessionId:'s'},{query:'approveDeployment'})
  expect(hits.hits.map(hit=>hit.path)).toEqual(['auth.ts'])
  move();expect((await runtime.codeRetrieval.search({sessionId:'s'},{query:'approveDeployment'})).hits).toEqual([])
})

it('owns refresh timers only while explicitly enabled and drains refresh on close',async()=>{
  const{runtime}=await setup()
  const intervals=vi.spyOn(globalThis,'setInterval'),cleared=vi.spyOn(globalThis,'clearInterval')
  const indexing=vi.spyOn(runtime.codeRetrieval,'startIndex')
  try{
    runtime.syncAutoRefresh();expect(intervals).not.toHaveBeenCalled()
    await runtime.codeRetrieval.configure({enabled:true});runtime.syncAutoRefresh();expect(intervals).not.toHaveBeenCalled()
    await runtime.codeRetrieval.configure({autoRefresh:true});runtime.syncAutoRefresh()
    expect(intervals).toHaveBeenCalledTimes(1)
    expect(indexing).toHaveBeenCalledTimes(1)
    const {jobId}=await indexing.mock.results[0]!.value
    expect((await runtime.codeRetrieval.wait(jobId)).lastJob?.outcome).toBe('completed')
    expect(runtime.codeRetrieval.status().state).toBe('ready')
    await runtime.codeRetrieval.configure({autoRefresh:false});runtime.syncAutoRefresh()
    expect(cleared).toHaveBeenCalledTimes(1)
    await runtime.close();expect(runtime.codeRetrieval.status().activeJobs).toBe(0)
  }finally{intervals.mockRestore();cleared.mockRestore();indexing.mockRestore()}
})

it.each([
  ['version', 2], ['id', `ctxv1_${'a'.repeat(64)}`], ['revision', 'b'.repeat(64)], ['codec', 'json-utf8-v1'], ['encodedBytes', 900], ['contentDigest', 'c'.repeat(64)], ['completeness', 'source-limited'],
] as const)('does not admit managed evidence with a wrong %s even when the target has a real pin', async (field, value) => {
  const { runtime, visibleRefs } = await setup()
  const scope = runtime.contextOutput.registerResultScope({ operationId: `exact-${field}`, sessionId: 's', callId: 'c', source: await runtime.sourceFor('s') }, () => true)
  const sink = await runtime.contextOutput.beginResult(scope, 'text-utf8-v1'); await sink.write(Buffer.from('full identity bytes'))
  const result = await sink.finish('complete'); if (result.kind !== 'committed') throw Error('fixture')
  await runtime.contextOutput.grant({ sessionId: 's' }, [result.ref.id], 'child')
  visibleRefs.child = [{ ...result.ref, [field]: value }]
  await expect(runtime.contextOutput.readResult({ sessionId: 'child' }, { ref: result.ref })).rejects.toThrow(/unauthorized/)
  visibleRefs.child = [{ ...result.ref }]
  expect((await runtime.contextOutput.readResult({ sessionId: 'child' }, { ref: result.ref })).data).toEqual({ kind: 'text', text: 'full identity bytes' })
})
