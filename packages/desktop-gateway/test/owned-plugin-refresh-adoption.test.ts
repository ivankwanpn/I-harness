import {expect,it} from 'vitest'
import {mkdtemp,mkdir,writeFile,unlink} from 'node:fs/promises'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createFsWatchService} from '@i-harness/fs-watch'
import {createRoleRegistry} from '@i-harness/subagent'
import {createOwnedPluginCatalog} from '../../session-executor/src/owned-plugin-catalog.ts'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {createSessionService,type SessionServiceOptions} from '../../session-executor/src/service.ts'
import {enrollFirstPartySelection} from '../../session-executor/src/first-party-selection.ts'
import {controlledModel} from '../../session-executor/test/controlled-model.ts'
import {createDesktopPlugins} from '../src/plugins.ts'
import {createDesktopMcp} from '../src/mcp-settings.ts'
import {createOwnedPluginMount} from '../src/owned-plugin-mount.ts'
import {createOwnedGatewaySelectionOwner} from '../src/owned-gateway-selection-owner.ts'

it('adopts a supported refreshed command only after the same original mount updates',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'owned-plugin-adoption-')),workspace=join(root,'workspace'),config=join(root,'config');await mkdir(workspace,{recursive:true});await mkdir(config,{recursive:true})
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(join(root,'sessions')),{lock:{enabled:true}},taskDocumentStorageContract);await coordinator.create({sessionId:'main'})
 const watch=createFsWatchService(),plugins=createDesktopPlugins(join(config,'plugins'),{watch}),mcp=createDesktopMcp(join(config,'mcp.json')),selection=createOwnedGatewaySelectionOwner({plugins,mcp,workspace,configDir:config});let request='',registry:any
 const model=controlledModel(async function*(value){request=JSON.stringify(value);yield {type:'end'}})
 const options:SessionServiceOptions={workspace,coordinator,managedRuntime:{systemPrompt:'system',tools:[],async mountDefaultSurface(original,live){registry=original.tools;const catalog=createOwnedPluginCatalog({ctx:original.ctx,tools:original.tools,roles:createRoleRegistry(),workspace,globalSkillDir:config,report(){},mcpDeps:{async connect(){return {async listTools(){return {tools:[{name:'echo',inputSchema:{type:'object'}}]}},async callTool(){return {content:[]}},async listResources(){return []},async readResource(){return {}},async close(){}}}}});const mount=createOwnedPluginMount({ctx:original.ctx,sessionId:original.domain.sessionId,startSource:'startup',workspace,configDir:config,report(){},catalog});original.retain(()=>mount.close());const selected=selection.current(original.domain.sessionId);selected.assertCurrent();await mount.update(selected.inputs,selected.directMcp);selected.assertCurrent();selection.bind(original,mount);return {systemPrompt:()=> 'system',modelToolSchemas:live.modelToolSchemas,modelOverheadTokens:()=>10,prepareInput:text=>mount.expand(text),async reconcileAuthority(){original.assertCurrent()}}}},model,contextWindow:32000,maxOutputTokens:128}
 enrollFirstPartySelection(Object.freeze({options,prepare:selection.prepare,refresh:selection.refresh,release:selection.release}));const service=createSessionService(options),observer=plugins.bindRefresh(()=>service.refreshExtensions());mcp.bindRefresh(()=>plugins.refresh())
 try{await service.submit('main','hello',new AbortController().signal);await mkdir(join(workspace,'commands'),{recursive:true});await writeFile(join(workspace,'commands','greet.md'),'---\ndescription: greet\n---\nhello $ARGUMENTS');await plugins.refresh();await service.submit('main','/greet world',new AbortController().signal);expect(request).toContain('hello world');const hookDir=join(workspace,'.i-harness','hooks');await mkdir(hookDir,{recursive:true});const hook=join(hookDir,'hooks.json');await writeFile(hook,'not json');await expect(plugins.refresh()).rejects.toThrow();await expect(service.submit('main','blocked',new AbortController().signal)).rejects.toThrow(/refresh requires recovery/);await unlink(hook);await plugins.refresh();await service.submit('main','/greet again',new AbortController().signal);expect(request).toContain('hello again');await plugins.mutate({action:'source/add',source:fileURLToPath(new URL('../../plugin-registry/test/fixtures/marketplace-a',import.meta.url))});await service.submit('main','/greet mutation',new AbortController().signal);expect(request).toContain('hello mutation');await mcp.mutate({action:'save',revision:0,config:{serverName:'direct',transport:'stdio',command:'fixture',args:[]}});await mcp.mutate({action:'enable',name:'direct'});expect((await mcp.state()).applyError).toBeUndefined();expect(registry.get('mcp__direct__echo')).toBeDefined();await service.submit('main','/greet mcp',new AbortController().signal);expect(request).toContain('hello mcp');await mcp.mutate({action:'disable',name:'direct'});expect((await mcp.state()).applyError).toBeUndefined();expect(registry.get('mcp__direct__echo')).toBeUndefined()}
 finally{await observer.close();await service.close();await plugins.close();await watch.close();await coordinator.close()}
},30000)
