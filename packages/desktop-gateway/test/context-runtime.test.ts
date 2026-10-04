import {afterEach,expect,it,vi} from 'vitest'
import {mkdir,mkdtemp,rm,stat,writeFile} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {createNativeContextRuntime} from '../src/context-runtime.ts'
const cleanup:Array<()=>Promise<void>>=[]
afterEach(async()=>{for(const operation of cleanup.splice(0).reverse())await operation()})
async function setup(){
  const base=resolve('build/native-context-runtime-tests');await mkdir(base,{recursive:true})
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
it('binds output references to actual session lineage and current project scope',async()=>{
  const{runtime,move,visibleRefs}=await setup();await runtime.contextOutput.configure({enabled:true})
  const ref=await runtime.contextOutput.capture({sessionId:'s',callId:'call',label:'test',text:'captured',complete:true,source:await runtime.sourceFor('s')})
  await expect(runtime.contextOutput.read({sessionId:'other'},{refId:ref!.id})).rejects.toThrow()
  await expect(runtime.contextOutput.read({sessionId:'child'},{refId:ref!.id})).rejects.toThrow()
  visibleRefs.child=[ref!]
  expect((await runtime.contextOutput.read({sessionId:'child'},{refId:ref!.id})).text).toBe('captured')
  move();await expect(runtime.contextOutput.read({sessionId:'s'},{refId:ref!.id})).rejects.toThrow()
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
  try{
    runtime.syncAutoRefresh();expect(intervals).not.toHaveBeenCalled()
    await runtime.codeRetrieval.configure({enabled:true});runtime.syncAutoRefresh();expect(intervals).not.toHaveBeenCalled()
    await runtime.codeRetrieval.configure({autoRefresh:true});runtime.syncAutoRefresh()
    expect(intervals).toHaveBeenCalledTimes(1)
    await vi.waitFor(()=>expect(runtime.codeRetrieval.status().state).toBe('ready'))
    await runtime.codeRetrieval.configure({autoRefresh:false});runtime.syncAutoRefresh()
    expect(cleared).toHaveBeenCalledTimes(1)
    await runtime.close();expect(runtime.codeRetrieval.status().activeJobs).toBe(0)
  }finally{intervals.mockRestore();cleared.mockRestore()}
})
