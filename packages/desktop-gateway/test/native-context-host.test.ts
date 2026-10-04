import {afterEach,expect,it} from 'vitest'
import {mkdir,mkdtemp,rm,stat,writeFile} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {encodeFrame,makeRequest,isRpcSuccess,type RpcMessage} from '@i-harness/sdk'
import {createDesktopHost} from '../src/host.ts'
const cleanup:Array<()=>Promise<void>>=[]
afterEach(async()=>{for(const operation of cleanup.splice(0).reverse())await operation()})
it('exposes native settings, applies both switches, indexes and resumes saved state',async()=>{
  const base=resolve('build/native-context-host-tests');await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'host-'))
  cleanup.push(()=>rm(root,{recursive:true,force:true}))
  const workspace=join(root,'workspace'),sessionDir=join(root,'sessions'),settingsPath=join(root,'settings.json')
  await mkdir(workspace);await mkdir(sessionDir);await writeFile(settingsPath,JSON.stringify({sandboxMode:'read-only'}))
  await writeFile(join(workspace,'code.ts'),'export function approveDeployment() { return true }')
  const frames:RpcMessage[]=[];let host=await createDesktopHost({workspace,sessionDir,settingsPath,onWrite:frame=>frames.push(frame)})
  cleanup.push(()=>host.close());let id=0
  const call=async(method:string,params={})=>{const current=++id;await host.handleLine(encodeFrame(makeRequest(current,method,params)));const reply=frames.find(frame=>'id'in frame&&frame.id===current);if(!isRpcSuccess(reply))throw new Error(JSON.stringify(reply));return reply.result as Record<string,any>}
  expect(await call('initialize')).toMatchObject({capabilities:{'desktop-context-subsystems':['1']}})
  expect(await call('desktop/context-subsystems/state')).toMatchObject({context:{enabled:false},code:{enabled:false}})
  await expect(stat(join(sessionDir,'native-context'))).rejects.toThrow()
  const enabled=await call('desktop/context-subsystems/configure',{patch:{scope:'workspace',contextOutput:{enabled:true},codeRetrieval:{enabled:true}}})
  expect(enabled).toMatchObject({source:'workspace',context:{enabled:true},code:{enabled:true}})
  await call('desktop/context-subsystems/action',{command:{target:'code',action:'update'}})
  let state=await call('desktop/context-subsystems/state')
  const deadline=Date.now()+5000
  while(state.code.state==='indexing'&&Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,10));state=await call('desktop/context-subsystems/state')}
  expect(state.code).toMatchObject({state:'ready',files:1})
  await host.close();host=await createDesktopHost({workspace,sessionDir,settingsPath,onWrite:frame=>frames.push(frame)})
  await call('initialize')
  expect(await call('desktop/context-subsystems/state')).toMatchObject({source:'workspace',context:{enabled:true},code:{enabled:true}})
  expect(await call('desktop/context-subsystems/configure',{patch:{scope:'workspace',contextOutput:{enabled:false},codeRetrieval:{enabled:false}}})).toMatchObject({context:{enabled:false,activeJobs:0},code:{enabled:false,activeJobs:0}})
})
