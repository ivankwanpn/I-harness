import {expect,it} from 'vitest'
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {createFsWatchService} from '@i-harness/fs-watch'
import {createDesktopPlugins} from '../src/plugins.ts'
import {createDesktopMcp} from '../src/mcp-settings.ts'
import {captureOwnedGatewaySelection} from '../src/owned-gateway-selection.ts'

it('fences changes to the real registry and effective authored hook list',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'gateway-inputs-witness-')),workspace=join(root,'workspace'),config=join(root,'config');await mkdir(workspace,{recursive:true});await mkdir(config,{recursive:true})
 const watch=createFsWatchService(),plugins=createDesktopPlugins(join(config,'plugins'),{watch})
 try{const selection=await captureOwnedGatewaySelection({plugins,mcp:createDesktopMcp(join(config,'mcp.json')),workspace,configDir:config});expect(selection.kind).toBe('managed');selection.assertCurrent();const hooks=join(workspace,'.i-harness','hooks');await mkdir(hooks,{recursive:true});await writeFile(join(hooks,'hooks.json'),JSON.stringify({version:1,handlers:[]}));expect(()=>selection.assertCurrent()).toThrow(/inputs changed/)}finally{await plugins.close();await watch.close()}
})
