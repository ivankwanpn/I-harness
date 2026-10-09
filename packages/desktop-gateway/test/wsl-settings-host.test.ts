import {afterEach,expect,it,vi} from 'vitest'
import {mkdir,mkdtemp,rm,writeFile}from'node:fs/promises'
import{join,resolve}from'node:path'
import * as sessionExecutor from '@i-harness/session-executor'
import {createDesktopHost}from'../src/host.ts'
import type{RpcMessage}from'@i-harness/sdk'
const roots:string[]=[]
afterEach(async()=>{vi.restoreAllMocks();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true})})
it('connects real gateway actions and captures managed paths only for new WSL assemblies',async()=>{
 await mkdir(resolve('.tmp'),{recursive:true});const root=await mkdtemp(resolve('.tmp/wsl-product-settings-host-'));roots.push(root)
 const workspace=join(root,'workspace'),sessionDir=join(root,'sessions'),settingsPath=join(root,'settings.json');await mkdir(workspace)
 const wslExecution={distribution:'Ubuntu',networkAccess:false,workspaceDependencies:true};await writeFile(settingsPath,JSON.stringify({windowsSandboxBackend:'legacy',wslExecution,webSearchMode:'cached'}))
 const manager={diagnose:vi.fn(async()=>({status:'missing' as const,detail:'managed node missing'})),repair:vi.fn(async()=>({status:'available' as const,detail:'managed node ready',path:'/cache/node/bin'})),resolve:vi.fn(async():Promise<{status:'available'|'missing'|'unavailable';detail:string;runtimePath?:string[]}>=>({status:'available',detail:'managed node ready',runtimePath:['/cache/node/bin']}))}
 let captured:sessionExecutor.SessionServiceOptions|undefined;const create=sessionExecutor.createSessionService
 vi.spyOn(sessionExecutor,'createSessionService').mockImplementation(options=>{captured=options;return create(options)})
 const frames:RpcMessage[]=[]
 const host=await createDesktopHost({workspace,sessionDir,settingsPath,workspaceRuntime:manager,wslSettings:{listDistributions:async()=>[{name:'Ubuntu',version:2,state:'Running'}],inspectRuntime:async distribution=>({distribution,available:true,detail:'ready',dependencies:{},paths:[]})},onWrite:frame=>frames.push(frame)})
 const call=async(id:number,method:string,params:unknown={})=>{await host.handleLine(JSON.stringify({jsonrpc:'2.0',id,method,params}));return frames.find(frame=>'id'in frame&&frame.id===id)}
 try{
  await call(1,'initialize');expect(await captured!.wslExecutionFor!()).toEqual(wslExecution);expect(manager.resolve).not.toHaveBeenCalled();expect(manager.diagnose).not.toHaveBeenCalled()
  expect(captured!.webCacheRoot).toBe(join(sessionDir,'web-cache'));expect(captured!.webSearchModeFor!()).toBe('cached')
  expect(await call(2,'desktop/agent-settings/configure',{windowsSandboxBackend:'wsl',wslExecution:{...wslExecution,distribution:'Debian'},webSearchMode:'disabled'})).toMatchObject({result:{effective:{windowsSandboxBackend:'wsl',webSearchMode:'disabled'}}})
  expect(await captured!.wslExecutionFor!()).toMatchObject({distribution:'Debian',runtimePath:['/cache/node/bin']});expect(manager.resolve).toHaveBeenLastCalledWith({...wslExecution,distribution:'Debian'},{installIfMissing:true})
  manager.resolve.mockResolvedValueOnce({status:'unavailable',detail:'Managed runtime integrity check failed'})
  await expect(captured!.wslExecutionFor!()).rejects.toThrow('Managed runtime integrity check failed')
  expect(captured!.webSearchModeFor!()).toBe('disabled')
  expect(await call(3,'desktop/wsl/diagnose')).toMatchObject({result:{managedDependencies:{status:'missing'}}})
  expect(await call(4,'desktop/wsl/repair')).toMatchObject({result:{managedDependencies:{status:'available'}}})
  await call(5,'desktop/agent-settings/configure',{wslExecution:{...wslExecution,distribution:'Debian',workspaceDependencies:false}})
  manager.resolve.mockClear()
  expect(await captured!.wslExecutionFor!()).not.toHaveProperty('runtimePath')
  expect(manager.resolve).not.toHaveBeenCalled()
  expect(await call(6,'desktop/wsl/repair')).toMatchObject({error:{message:expect.stringContaining('disabled')}});expect(manager.repair).toHaveBeenCalledTimes(1)
 }finally{await host.close()}
})
