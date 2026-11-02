import {expect,it,vi} from 'vitest'
import type {SessionView} from '@i-harness/core-session'
import {captureOriginalSettlementCloseAck} from '../../session-persistence/src/coordinator/settlement-source.ts'
import {TaskPersistence} from '../../subagent/src/task/persistence.ts'
import {createDeliveryFixture} from './helpers/delivery-fixture.ts'

const cut=vi.hoisted(()=>({parent:undefined as SessionView|undefined,mode:'producer' as 'producer'|'source',allow:false,events:[] as string[],mounted:undefined as ReturnType<typeof import('../../subagent/src/index.ts').registerSubagent>|undefined,childRuntime:undefined as SessionView|undefined,childAck:false,producerFailure:undefined as {cause:unknown}|undefined,childFailures:0,childAcks:0,terminal:0,exec:0,mcp:0,client:0,host:0,manager:0,runtime:0,result:0}))
vi.mock('../../runtime-context/src/index.ts',async load=>{
 const actual=await load<typeof import('../../runtime-context/src/index.ts')>()
 return {...actual,createRuntimeContext(...args:Parameters<typeof actual.createRuntimeContext>){const runtime=actual.createRuntimeContext(...args),close=runtime.close.bind(runtime),parent=args[0]===cut.parent
  if(cut.parent&&!parent){expect(cut.childRuntime).toBeUndefined();cut.childRuntime=args[0]}
  runtime.close=async()=>{if(parent){cut.events.push('root-runtime');cut.runtime++;return close()}
   if(cut.mode==='producer'&&!cut.allow){cut.childFailures++;cut.events.push('child-cleanup-failed');throw false}
   await close();cut.childAck=true;cut.childAcks++;cut.events.push('child-cleanup-ack')}
  return runtime}
 }
})
vi.mock('../../subagent/src/index.ts',async load=>{
 const actual=await load<typeof import('../../subagent/src/index.ts')>()
 return {...actual,registerSubagent(...args:Parameters<typeof actual.registerSubagent>){const mounted=actual.registerSubagent(...args)
  if(args[2].parentSession===cut.parent){cut.mounted=mounted;const dispose=mounted.dispose.bind(mounted);mounted.dispose=async()=>{cut.events.push('child-producer-attempt');try{await dispose()}catch(cause){cut.producerFailure={cause};throw cause}cut.events.push('child-producer-ack')}}return mounted}
 }
})
vi.mock('../../exec/src/index.ts',async load=>{
 const actual=await load<typeof import('../../exec/src/index.ts')>()
 return {...actual,registerExecWithReservation(...args:Parameters<typeof actual.registerExecWithReservation>){const pair=actual.registerExecWithReservation(...args),dispose=pair.service.dispose.bind(pair.service);pair.service.dispose=async()=>{cut.exec++;cut.events.push('exec-producer');await dispose()};return pair}}
})
vi.mock('../../terminal/src/index.ts',async load=>{
 const actual=await load<typeof import('../../terminal/src/index.ts')>()
 return {...actual,registerTerminal(...args:Parameters<typeof actual.registerTerminal>){const mount=actual.registerTerminal(...args),dispose=mount.dispose.bind(mount);mount.dispose=async()=>{cut.terminal++;cut.events.push('terminal-producer');await dispose()};return mount}}
})
vi.mock('../../mcp-client/src/index.ts',async load=>{
 const actual=await load<typeof import('../../mcp-client/src/index.ts')>()
 return {...actual,async mountMcpClient(...args:Parameters<typeof actual.mountMcpClient>){
  const client:import('../../mcp-client/src/index.ts').ConnectedMcpClient={async listTools(){return{tools:[{name:'probe',description:'Retained original MCP tool',inputSchema:{type:'object',properties:{}}}]}},async callTool(){return{content:[{type:'text',text:'original MCP result'}]}},async listResources(){return[]},async readResource(){throw Error('Not used')},async close(){cut.client++}}
  const mount=await actual.mountMcpClient(args[0],args[1],args[2],{connect:async()=>client}),unmount=mount.unmount.bind(mount)
  mount.unmount=async()=>{cut.mcp++;cut.events.push('mcp-unmount');await unmount()};return mount}
 }
})
vi.mock('../src/context/instructions/child-host.ts',async load=>{
 const actual=await load<typeof import('../src/context/instructions/child-host.ts')>()
 return {...actual,createChildInstructionHost(...args:Parameters<typeof actual.createChildInstructionHost>){const host=actual.createChildInstructionHost(...args),close=host.close.bind(host);host.close=async()=>{cut.host++;cut.events.push('instruction-host');await close()};return host}}
})
vi.mock('../src/context/instructions/manager.ts',async load=>{
 const actual=await load<typeof import('../src/context/instructions/manager.ts')>()
 return {...actual,createMainInstructionManager(...args:Parameters<typeof actual.createMainInstructionManager>){const manager=actual.createMainInstructionManager(...args),close=manager.close.bind(manager);if(args[0].session===cut.parent)manager.close=async()=>{cut.manager++;cut.events.push('instruction-manager');await close()};return manager}}
})
vi.mock('../src/lifecycle/result-store.ts',async load=>{
 const actual=await load<typeof import('../src/lifecycle/result-store.ts')>()
 return {...actual,async acquireAssemblyResultStore(...args:Parameters<typeof actual.acquireAssemblyResultStore>){const store=await actual.acquireAssemblyResultStore(...args),release=store.release.bind(store);store.release=async()=>{cut.result++;cut.events.push('result-release');await release()};return store}}
})

it.each(['producer','source'] as const)('retains original borrowed MCP/role/instruction owners until the same %s cleanup acknowledges',async mode=>{
 Object.assign(cut,{parent:undefined,mode,allow:false,events:[],mounted:undefined,childRuntime:undefined,childAck:false,producerFailure:undefined as {cause:unknown}|undefined,childFailures:0,childAcks:0,terminal:0,exec:0,mcp:0,client:0,host:0,manager:0,runtime:0,result:0})
 const toolName='mcp__ordered-mcp__probe',f=await createDeliveryFixture({roleTools:[toolName],extensionsFor:async()=>({options:{pluginMcp:[{transport:'stdio',serverName:'ordered-mcp',command:'controlled',args:[],directTools:['probe']}]}})})
 const document=await f.coordinator.openManagedDocument('parent');cut.parent=document.view
 const closeDocument=document.close.bind(document);let documentCloses=0;document.close=async()=>{cut.events.push('document-close');await closeDocument();documentCloses++}
 const captures:ReturnType<TaskPersistence['captureRequiredSave']>[]=[],capture=TaskPersistence.prototype.captureRequiredSave,spy=vi.spyOn(TaskPersistence.prototype,'captureRequiredSave').mockImplementation(function(this:TaskPersistence,...args){const save=capture.apply(this,args);captures.push(save);return save})
 let action:ReturnType<typeof document.beginAction>|undefined,source:ReturnType<ReturnType<typeof document.beginAction>['registerSettlementSource']>|undefined,off:(()=>void)|undefined
 try{
  await f.start();expect(f.launchCount()).toBe(1);const mounted=cut.mounted!,entry=mounted.table.get('root/original0')!;expect(entry.session).toBe(cut.childRuntime);expect(entry.toolRegistry?.get(toolName)).toBeDefined()
  const role=mounted.roles.get('probe')!;expect(role.tools).toContain(toolName);let rolePresent=true,roleRemovals=0;off=mounted.roles.onChanged(()=>{const present=mounted.roles.get('probe')!==undefined;if(rolePresent&&!present){roleRemovals++;cut.events.push('role-cleanup')}rolePresent=present})
  let sourceDrains=0,sourceAck=false;action=document.beginAction();source=action.registerSettlementSource(async()=>{sourceDrains++;cut.events.push('source-drain');expect(cut.childAck).toBe(true);if(mode==='source'&&!cut.allow)throw undefined});action.finish()
  const ack=captureOriginalSettlementCloseAck(source)!;void ack.then(()=>{sourceAck=true;cut.events.push('source-ack')})
  const assembly=await f.service.assemblyFor('parent'),closing=assembly.dispose();void closing.catch(()=>{});f.releaseChild();let failed=false,cause:unknown;await closing.catch(error=>{failed=true;cause=error});expect(failed).toBe(true);expect(cause).toBeInstanceOf(AggregateError)
  expect((cause as AggregateError).message).toBe('Assembly extension/process cleanup incomplete');expect((cause as AggregateError).errors).toHaveLength(1)
  const originalFailure=(cause as AggregateError).errors[0] as AggregateError;expect(originalFailure).toBeInstanceOf(AggregateError);expect(originalFailure.message).toBe(mode==='producer'?'Assembly original producer cleanup incomplete':'Assembly original source cleanup incomplete')
  if(mode==='producer'){expect(cut.childFailures).toBeGreaterThan(0);expect(originalFailure.errors).toEqual([cut.producerFailure!.cause])}else{const ownerFailure=originalFailure.errors[0] as Error;expect(ownerFailure).toMatchObject({code:'FACT_RECOVERY_REQUIRED'});expect(((ownerFailure.cause as AggregateError).errors[0] as AggregateError).errors).toEqual([undefined])}
  expect(cut.terminal).toBe(1);expect(cut.exec).toBe(1);expect(sourceAck).toBe(false);expect(sourceDrains).toBe(mode==='producer'?0:1)
  expect(mounted.roles.get('probe')).toBe(role);expect(roleRemovals).toBe(0);expect(cut.mcp).toBe(0);expect(cut.client).toBe(0);expect([cut.host,cut.manager,cut.runtime,documentCloses,cut.result]).toEqual([0,0,0,0,0])
  // The original live claim prelude and terminal each have their own captured
  // save. Retry must retain both exact handles, not reserve another snapshot.
  expect(captures).toHaveLength(2);const originalSaves=[...captures];expect(originalSaves.every(save=>save.outcome()?.kind==='committed')).toBe(true);expect(()=>document.assertReady()).toThrow()
  cut.allow=true;await assembly.dispose();await ack
  expect(captures).toEqual(originalSaves);expect(f.launchCount()).toBe(1);expect(cut.childAcks).toBe(1);expect(cut.terminal).toBe(1);expect(cut.exec).toBe(1);expect(sourceDrains).toBe(mode==='producer'?1:2)
  expect(roleRemovals).toBe(1);expect(cut.mcp).toBe(1);expect(cut.client).toBe(1);expect([cut.host,cut.manager,cut.runtime,documentCloses,cut.result]).toEqual([1,1,1,1,1])
  const at=(name:string)=>cut.events.indexOf(name);expect(at('child-producer-ack')).toBeLessThan(at('source-ack'));expect(at('source-ack')).toBeLessThan(at('role-cleanup'));expect(at('role-cleanup')).toBeLessThan(at('mcp-unmount'));expect(at('mcp-unmount')).toBeLessThan(at('instruction-host'));expect(at('instruction-manager')).toBeLessThan(at('document-close'));expect(at('document-close')).toBeLessThan(at('result-release'))
 }catch(cause){console.info('original-borrowed-owner-primary',mode,cut.events,cause);throw cause}finally{cut.allow=true;f.releaseChild();action?.finish();off?.();spy.mockRestore();await f.close();await source?.close()}
},60_000)
