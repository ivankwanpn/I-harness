import {expect,it} from 'vitest'
import {mkdir,mkdtemp,rm} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {createContextOutputService} from '../src/index.ts'
it('preserves explicit host fork ownership while retrieval is disabled',async()=>{
  const base=resolve('build/native-disabled-grant');await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'grant-'))
  const service=createContextOutputService({root,workspaceId:'w',config:{enabled:true}})
  try{
    const ref=await service.capture({sessionId:'parent',callId:'call',label:'result',text:'fork retained',complete:true})
    await service.configure({enabled:false})
    await service.grant({sessionId:'parent'},[ref!.id],'fork')
    await expect(service.read({sessionId:'fork'},{refId:ref!.id})).rejects.toThrow()
    await service.clear('parent');await service.configure({enabled:true})
    expect((await service.read({sessionId:'fork'},{refId:ref!.id})).text).toBe('fork retained')
  }finally{await service.close();await rm(root,{recursive:true,force:true})}
})
