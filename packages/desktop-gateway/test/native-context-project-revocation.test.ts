import {expect,it} from 'vitest'
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {createSessionCoordinator} from '@i-harness/session-persistence'
import {createJsonlBackend} from '@i-harness/session-persistence-jsonl'
import {createProjectScopeBroker} from '../src/project-scope.ts'
import {createNativeContextRuntime} from '../src/context-runtime.ts'

it('catalog revocation never turns a durable project binding into workspace or reference authority',async()=>{
  const base=resolve('build/native-project-revocation');await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'scope-'))
  const workspace=join(root,'workspace'),other=join(root,'other'),reference=join(root,'reference')
  for(const path of [workspace,other,reference])await mkdir(path)
  await writeFile(join(workspace,'work.ts'),'export const WORKSPACE_SECRET = true')
  await writeFile(join(reference,'ref.ts'),'export const REFERENCE_SECRET = true')
  const coordinator=createSessionCoordinator(createJsonlBackend(join(root,'sessions')));await coordinator.create({sessionId:'s'});await coordinator.create({sessionId:'unassigned'})
  const broker=createProjectScopeBroker(coordinator,workspace)
  const runtime=await createNativeContextRuntime({workspace,storageRoot:join(root,'native'),coordinator,
    projectFor:broker.nativeScopeFor,references:[{id:'ref',path:reference,label:'Reference'}]})
  try{
    await broker.configure({id:'p',name:'Other',roots:[other],primaryRoot:other});await broker.bind('s','p')
    await runtime.codeRetrieval.configure({enabled:true});await runtime.contextOutput.configure({enabled:true})
    const index=await runtime.codeRetrieval.startIndex({sessionId:runtime.humanSessionId});await runtime.codeRetrieval.wait(index.jobId)
    expect((await runtime.codeRetrieval.search({sessionId:'s'},{query:'SECRET'})).hits).toEqual([])
    expect((await runtime.codeRetrieval.search({sessionId:'unassigned'},{query:'SECRET'})).hits).toHaveLength(2)
    await broker.sync([])
    expect(await broker.projectFor('s')).toBe('p')
    expect((await runtime.codeRetrieval.search({sessionId:'s'},{query:'SECRET'})).hits).toEqual([])
    const denied=await runtime.codeRetrieval.startIndex({sessionId:'s'})
    const deniedState=await runtime.codeRetrieval.wait(denied.jobId)
    expect(deniedState.lastJob?.outcome).toBe('failed')
    await expect(runtime.sourceFor('s')).rejects.toThrow()
    await broker.configure({id:'p',name:'Confirmed',roots:[workspace],primaryRoot:workspace})
    expect((await runtime.codeRetrieval.search({sessionId:'s'},{query:'SECRET'})).hits).toHaveLength(2)
    const restored=await runtime.codeRetrieval.startIndex({sessionId:'s'});expect((await runtime.codeRetrieval.wait(restored.jobId)).state).toBe('ready')
    const ref=(await runtime.contextOutput.capture({sessionId:'s',callId:'scoped',label:'scoped',text:'owned result',complete:true,source:await runtime.sourceFor('s')}))!
    await broker.revoke('p');await expect(runtime.contextOutput.read({sessionId:'s'},{refId:ref.id})).rejects.toThrow()
    await broker.configure({id:'p',name:'Restored',roots:[workspace],primaryRoot:workspace})
    expect((await runtime.contextOutput.read({sessionId:'s'},{refId:ref.id})).text).toBe('owned result')
  }finally{await runtime.close();await broker.close();await coordinator.close();await rm(root,{recursive:true,force:true})}
})
