import {expect,it} from 'vitest'
import {mkdtemp,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {classifyOwnedGatewayHooks} from '../src/owned-gateway-hook-selection.ts'

it('uses the original loader and fences the selected native hook revision',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'hook-select-')),path=join(root,'hooks.json');await writeFile(path,JSON.stringify({version:1,handlers:[]}))
 let current=true;const selection=await classifyOwnedGatewayHooks({configDir:root,hookConfigs:[path],assertInputsCurrent(){if(!current)throw Error('plugin inputs changed')}})
 expect(selection.kind).toBe('managed');selection.assertCurrent();await writeFile(path,JSON.stringify({version:1,handlers:[],changed:true}));expect(()=>selection.assertCurrent()).toThrow(/changed/);current=false;expect(()=>selection.assertCurrent()).toThrow(/inputs changed/)
})
it('selects complete before acquisition for installed physical hook configuration',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'hook-physical-'))
 const selection=await classifyOwnedGatewayHooks({configDir:root,hookConfigs:[join(root,'plugins','x','hooks','hooks.json')],assertInputsCurrent(){}})
 expect(selection.kind).toBe('complete')
})
