import {expect,it} from 'vitest'
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createFsWatchService} from '@i-harness/fs-watch'
import {createDesktopPlugins} from '../src/plugins.ts'

it('uses the original post-mutation refresh scope to capture current registry inputs',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'plugin-refresh-witness-')),watch=createFsWatchService(),plugins=createDesktopPlugins(root,{watch});let captured=0
 const observer=plugins.bindRefresh(async()=>{const witness=await plugins.inputsWitness();witness.assertCurrent();captured++})
 try{await plugins.mutate({action:'source/add',source:fileURLToPath(new URL('../../plugin-registry/test/fixtures/marketplace-a',import.meta.url))});expect(captured).toBeGreaterThan(0)}finally{await observer.close();await plugins.close();await watch.close()}
},30000)
