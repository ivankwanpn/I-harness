import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect,it } from 'vitest'
it.skipIf(process.env.IH_ACL_ABI_QUALIFICATION!=='1')('qualifies the accepted extended startup leaf with one restricted child and whitelist sentinel',()=>{
  const root=process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,assets=process.env.IH_ACL_ABI_ASSETS!
  if(!root||!assets)throw new Error('assigned roots/assets required')
  const output=join(root,'abi-windows');mkdirSync(output)
  const argv=['--import',pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href,fileURLToPath(new URL('./fixtures/abi-windows.ts',import.meta.url))]
  const env={...process.env,NODE_OPTIONS:'',NODE_DISABLE_COMPILE_CACHE:'1',TSX_DISABLE_CACHE:'1',TEMP:output,TMP:output,IH_ACL_ABI_TRACE:join(output,'trace.jsonl'),IH_ACL_ABI_CWD:output}
  writeFileSync(join(output,'command.json'),JSON.stringify({executable:process.execPath,argv,cwd:process.cwd(),assets,timeoutMs:20000,privateTemp:output},null,2))
  const result=spawnSync(process.execPath,argv,{cwd:process.cwd(),env,encoding:'utf8',timeout:20000,windowsHide:true})
  writeFileSync(join(output,'stdout.txt'),result.stdout??'');writeFileSync(join(output,'stderr.txt'),result.stderr??'')
  writeFileSync(join(output,'result.json'),JSON.stringify({status:result.status,pid:result.pid,signal:result.signal,error:result.error?.message},null,2))
  expect(result.error,result.stderr+result.stdout).toBeUndefined();expect(result.status,result.stderr+result.stdout).toBe(0)
  expect(result.stdout).toContain('restricted-child-positive-and-whitelist-negative');expect(result.stdout).toContain('all-original-owners-clean-and-worker-exit-joined')
},25000)
