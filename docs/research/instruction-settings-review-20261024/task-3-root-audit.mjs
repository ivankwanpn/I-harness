import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {createRequire} from 'node:module'
const root='C:/Users/inkik/.codex/worktrees/context-current/I-harness-main'
const evidence=new URL('./task-3-evidence/',import.meta.url)
const read=n=>fs.readFileSync(new URL(n,evidence),'utf8')
const digest=b=>crypto.createHash('sha256').update(b).digest('hex')
const git=args=>execFileSync('git',args,{cwd:root,encoding:'utf8',windowsHide:true}).trim()
const base='bdc1e05c78dee2c6f100feb725e5a9561487a93b',head='fe0174d5f8124d92ba3728c6046d1908844e9079'
const errors=[],maps=['final-before-hashes.txt','final-after-suite-hashes.txt','final-after-types-hashes.txt','committed-hashes.txt'].map(n=>new Map([...read(n).matchAll(/^SHA256\s+([0-9A-F]{64})\s+(.+)$/gm)].map(m=>[m[2].trim().replaceAll('\\','/'),m[1].toLowerCase()])))
const files=[]
for(const [f,h] of maps[0]){
 if(!f.toLowerCase().startsWith(root.toLowerCase()+'/')){errors.push(`outside:${f}`);continue}
 if(digest(fs.readFileSync(f))!==h || maps.slice(1).some(m=>m.get(f)!==h))errors.push(`hash:${f}`)
 files.push({path:f.slice(root.length+1),sha256:h})
}
const changed=git(['diff','--name-only',`${base}..${head}`]).split('\n')
for(const f of changed){
 const b=git(['rev-parse',`${head}:${f}`])
 if(git(['hash-object','--path',f,f])!==b || !files.some(x=>x.path===f))errors.push(`commit:${f}`)
}
const resolution={},req=createRequire(path.join(root,'packages/settings/package.json'))
for(const n of ['fs-watch','telemetry','harness-home']){
 resolution[n]=fs.realpathSync(req.resolve(`@i-harness/${n}`)).replaceAll('\\','/')
 if(!resolution[n].toLowerCase().startsWith(root.toLowerCase()+'/packages/'))errors.push(`dependency:${n}`)
}
for(const n of ['final-suite-receipt.txt','final-types-receipt.txt'])if(!/exit=0/.test(read(n)))errors.push(`exit:${n}`)
const plain=read('final-suite.log').replace(/\x1b\[[0-9;]*m/g,'')
if(!/Test Files\s+6 passed \(6\)/.test(plain)||!/Tests\s+140 passed \(140\)/.test(plain))errors.push('suite-result')
const result={at:new Date().toISOString(),base,head,checked:files.length,changed:changed.length,resolution,files,errors}
fs.writeFileSync(new URL('./task-3-root-audit.json',import.meta.url),JSON.stringify(result,null,2)+'\n')
console.log(JSON.stringify({checked:files.length,changed:changed.length,errors}))
process.exitCode=errors.length?1:0
