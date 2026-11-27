import { expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isRpcSuccess, type RpcMessage } from '@i-harness/sdk'
import { controlledModel } from '../../session-executor/test/controlled-model.ts'
import { createDesktopHost } from '../src/host.ts'
import type { DesktopExecutionView } from '../src/execution.ts'
import type { ExecutionSurfaceSnapshot, SurfaceLease } from '../src/observation/types.ts'

it('reads the existing private Code cell through the retained surface and stops only its original live owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-gateway-managed-code-')), workspace = join(root, 'workspace'), sessionDir = join(root, 'sessions')
  await mkdir(workspace)
  const settingsPath = join(root, 'settings.json'), credentialsPath = join(root, 'credentials.json')
  await writeFile(settingsPath, JSON.stringify({ autoTitle:false, sandboxMode:'read-only', approvalMode:'dangerous', compaction:{auto:false}, codeMode:{mode:'mixed'},
    llm:{providers:{fixture:{protocol:'openai-completions',baseURL:'http://127.0.0.1:1',apiKeyEnv:'IH_MANAGED_CODE_FIXTURE',models:[{id:'fixture',contextWindow:32000}]}},defaultModel:{provider:'fixture',model:'fixture'}} }))
  await writeFile(credentialsPath, JSON.stringify({ refs:{IH_MANAGED_CODE_FIXTURE:'synthetic-only'} }))
  let requests=0, launches=0, issued=false
  const model=controlledModel(async function*(){
    requests++
    if (!issued) {
      issued=true
      yield {type:'tool_call',call:{id:`code-cell-fixture-${++launches}`,name:'code_exec',args:{code:'await new Promise(resolve => setTimeout(resolve, 25000)); text("late fixture")',yield_time_ms:0}}}
    } else yield {type:'text/chunk',text:'fixture code launched'}
    yield {type:'end'}
  })
  const frames: RpcMessage[]=[]
  const host=await createDesktopHost({workspace,sessionDir,settingsPath,credentialsPath,onWrite:frame=>frames.push(frame),buildProviderClient:()=>model})
  let serial=0
  async function call(method:string,params:unknown={}) {
    const id=++serial
    await host.handleLine(JSON.stringify({jsonrpc:'2.0',id,method,params}))
    const response=frames.findLast(frame=>'id'in frame&&frame.id===id)
    if(!isRpcSuccess(response))throw Error(JSON.stringify(response))
    return response.result
  }
  try {
    const initialized=await call('initialize')
    expect(initialized).toMatchObject({capabilities:{'desktop-surface-events':['1']}})
    await call('desktop/project/sync',{projects:[{id:'fixture',name:'Fixture',roots:[workspace],primaryRoot:workspace}]})
    const {sessionId}=await call('session/create') as {sessionId:string}
    const {sessionId:other}=await call('session/create') as {sessionId:string}
    expect(await call('session/warm',{sessionId})).toEqual({ready:false,deferred:true})
    expect(await call('desktop/session/execution/read',{sessionId})).toMatchObject({live:false,cells:[]})
    expect(await call('desktop/code-mode/state',{sessionId})).toMatchObject({live:false})
    expect(requests).toBe(0)

    await call('session/prompt',{sessionId,prompt:'start one original Code cell'})
    expect(requests).toBe(2)
    expect(await call('desktop/code-mode/state',{sessionId})).toMatchObject({live:true,effective:'mixed'})
    const lease=await call('desktop/surface/subscribe',{surface:'execution',sessionId,requestKey:'r1:1'}) as SurfaceLease
    const leaseRequest={subscriptionId:lease.subscriptionId,epoch:lease.stamp.epoch,offset:0,limit:10}
    const snapshot=await call('desktop/surface/snapshot',leaseRequest) as ExecutionSurfaceSnapshot
    expect(snapshot).toMatchObject({kind:'snapshot',value:{sessionId,live:true,effectiveMode:'mixed',cells:[{ownerSessionId:sessionId,live:true,canTerminate:true}]}})
    if(snapshot.kind!=='snapshot')throw Error('Original managed Code snapshot missing')
    const cellId=snapshot.value.cells[0]!.id
    await expect(call('desktop/session/execution/stop',{sessionId:other,cellId})).rejects.toThrow(/live execution owner/)
    expect(await call('desktop/session/execution/read',{sessionId})).toMatchObject({cells:[{id:cellId,live:true,canTerminate:true}]})
    expect(await call('desktop/session/execution/stop',{sessionId,cellId})).toEqual({stopped:true,cellId})
    await expect.poll(async()=>{
      const view=await call('desktop/session/execution/read',{sessionId}) as DesktopExecutionView
      return view.cells.find(cell=>cell.id===cellId)
    }).toMatchObject({id:cellId,status:'terminated',live:false,canTerminate:false})
    await call('desktop/session/reload',{sessionId})
    await expect(call('desktop/surface/snapshot',leaseRequest)).rejects.toThrow()
    await expect(call('desktop/session/execution/stop',{sessionId,cellId})).rejects.toThrow(/live execution owner/)
    expect(await call('desktop/session/execution/read',{sessionId})).toMatchObject({live:false,cells:[{id:cellId,status:'terminated',live:false,canTerminate:false}]})

    await call('session/prompt',{sessionId:other,prompt:'select the other conversation without launching Code'})
    expect(await call('desktop/session/execution/read',{sessionId:other})).toMatchObject({live:true,cells:[]})
    issued=false
    await call('session/prompt',{sessionId,prompt:'launch a replacement Code cell'})
    expect(launches).toBe(2)
    const replacement=await call('desktop/session/execution/read',{sessionId}) as DesktopExecutionView
    const newCell=replacement.cells.find(cell=>cell.live&&cell.canTerminate)!
    expect(newCell.id).not.toBe(cellId)
    await expect(call('desktop/surface/snapshot',leaseRequest)).rejects.toThrow()
    await expect(call('desktop/session/execution/stop',{sessionId,cellId})).rejects.toThrow(/live execution owner/)
    await expect(call('desktop/session/execution/stop',{sessionId:other,cellId:newCell.id})).rejects.toThrow(/live execution owner/)
    expect(await call('desktop/session/execution/read',{sessionId})).toMatchObject({cells:[{id:newCell.id,live:true,canTerminate:true},{id:cellId,live:false,canTerminate:false}]})
    expect(await call('desktop/session/execution/stop',{sessionId,cellId:newCell.id})).toEqual({stopped:true,cellId:newCell.id})
  } finally {try{await host.close()}finally{await rm(root,{recursive:true,force:true})}}
},60_000)
