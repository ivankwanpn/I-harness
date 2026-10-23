import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {execFileSync} from 'node:child_process'
const root='C:/Users/inkik/.codex/worktrees/context-current/I-harness-main'
const evidence=new URL('./evidence/',import.meta.url)
const read=n=>JSON.parse(fs.readFileSync(new URL(n,evidence),'utf8'))
const hash=b=>crypto.createHash('sha256').update(b).digest('hex')
const git=a=>execFileSync('git',a,{cwd:root,encoding:'utf8',windowsHide:true}).trim()
const initial=read('commit-source-binding.json'),fix=read('round1-commit-source-binding.json'),errors=[]
const selected=new Map(initial.bindings.map(f=>[f.file,{...f,fix:false}]))
for(const f of fix.bindings)selected.set(f.file,{...f,fix:true})
const changed=git(['diff','--name-only',`${initial.base}..${fix.head}`]).split('\n')
for(const [p,f] of selected){
 const actual=hash(fs.readFileSync(path.join(root,p)))
 if(actual!==f.physicalSha256||git(['hash-object','--path',p,p])!==f.headBlob||git(['rev-parse',`${fix.head}:${p}`])!==f.headBlob)errors.push(`source:${p}`)
 if(f.fix){const r=read(f.receipt+'.json');if(r.sourceBefore[p]!==actual||r.sourceAfter[p]!==actual||f.testedBefore!==actual||f.testedAfter!==actual)errors.push(`fix-test:${p}`)}
 else if(f.testedSha256!==actual)errors.push(`initial-test:${p}`)
}
if(changed.length!==selected.size||changed.some(p=>!selected.has(p)))errors.push('scope')
let evidenceFiles=0
for(const name of ['evidence-index.json','round1-evidence-index.json'])for(const f of read(name).files){
 const p=f.path??f.file
 if(hash(fs.readFileSync(new URL(p,evidence)))!==f.sha256)errors.push(`evidence:${name}:${p}`)
 evidenceFiles++
}
const comparison=read('failure-comparison-final.json')
if(comparison.newFailures.length!==0||comparison.previouslyFailingNowPassing.length!==6)errors.push('failure-comparison')
const result={at:new Date().toISOString(),base:initial.base,head:fix.head,files:selected.size,evidenceFiles,newFailures:comparison.newFailures,previouslyFailingNowPassing:comparison.previouslyFailingNowPassing,remainingAgentFailures:35,errors}
fs.writeFileSync(new URL('./root-audit.json',import.meta.url),JSON.stringify(result,null,2)+'\n')
console.log(JSON.stringify({files:result.files,evidenceFiles,errors}));process.exitCode=errors.length?1:0
