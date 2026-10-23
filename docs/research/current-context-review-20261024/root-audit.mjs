import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { gunzipSync } from 'node:zlib'
import { createRequire } from 'node:module'
const root = 'C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main'
const evidence = path.join(root, '.superpowers/current-context-qualification')
const read = n => JSON.parse(fs.readFileSync(path.join(evidence,n),'utf8'))
const hash = b => crypto.createHash('sha256').update(b).digest('hex')
const git = args => execFileSync('git',args,{cwd:root,encoding:'utf8',windowsHide:true}).trim()
const binding = read('commit-source-binding.json')
const before = read('final-source-before.json'), after = read('final-source-after.json')
const errors=[]
const lookup = x => new Map(Array.isArray(x) ? x.map(r=>[r.path,r.sha256]) : Object.entries(x).map(([p,v])=>[p,typeof v==='string'?v:v.sha256]))
const bm=lookup(before.files), am=lookup(after.files)
const changed = git(['diff','--name-only',`${binding.base}..${binding.head}`]).split('\n')
for(const f of binding.files){
 const bytes=fs.readFileSync(path.join(root,f.path)), actual=hash(bytes)
 if(actual!==f.sha256 || bm.get(f.path)!==actual || am.get(f.path)!==actual) errors.push(`source:${f.path}`)
 if(git(['rev-parse',`${binding.head}:${f.path}`])!==f.headBlob) errors.push(`head-blob:${f.path}`)
 if(f.baseBlob && git(['rev-parse',`${binding.base}:${f.path}`])!==f.baseBlob) errors.push(`base-blob:${f.path}`)
 if(git(['hash-object','--path',f.path,f.path])!==f.headBlob) errors.push(`working-blob:${f.path}`)
}
if(changed.length!==binding.files.length || changed.some(p=>!binding.files.some(f=>f.path===p))) errors.push('changed-file-coverage')
const testReport=read('final-tests.json'), baseReport=read('baseline-results.json')
const failedNames = (r,rootPrefix) => r.testResults.flatMap(file=>file.assertionResults.filter(a=>a.status==='failed').map(a=>`${file.name.replaceAll('\\','/').replace(rootPrefix.replaceAll('\\','/'),'')}::${a.fullName}`)).sort()
const baseline=read('baseline-source-verification.json')
const currentFailures=failedNames(testReport,root), oldFailures=failedNames(baseReport,baseline.root)
const newFailures=currentFailures.filter(n=>!oldFailures.includes(n))
const resolved=oldFailures.filter(n=>!currentFailures.includes(n))
const commands=read('final-commands.json')
if(commands.length!==9 || commands[0].exit!==1 || commands.slice(1).some(c=>c.exit!==0)) errors.push('command-exits')
for(let i=1;i<commands.length;i++) if(Date.parse(commands[i].start)<Date.parse(commands[i-1].end)) errors.push(`overlap:${i}`)
if(newFailures.length || resolved.length || currentFailures.length!==42) errors.push('failure-population')
const diagnostic='packages/desktop-gateway/test/repeated-growth-diagnosis.test.ts'
if(hash(fs.readFileSync(path.join(root,diagnostic)))!=='9fb750a75ec847dc97dd95d16e7ec7668b65d919bcb8208805f9a34fb93cec68') errors.push('diagnostic-modified')
const capsules=[]
const localRequire=createRequire(path.join(root,'packages/fs-watch/package.json'))
const chokidarRoot=path.dirname(localRequire.resolve('chokidar'))
const dependencyRoots={chokidar:chokidarRoot,readdirp:path.dirname(createRequire(path.join(chokidarRoot,'package.json')).resolve('readdirp'))}
for(const [name,commit] of [['current-context-format1','460a2aee9395dafe196eb31425dcc2c3fcdc259e'],['current-context-format11',binding.base]]){
 const dir=path.join(root,'packages/session-persistence-jsonl/test/fixtures',name)
 const m=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'),'utf8')), zip=fs.readFileSync(path.join(dir,'graph.json.gz'))
 const decoded=gunzipSync(zip), graph=JSON.parse(decoded.toString('utf8')), entries=new Map(graph.files.map(f=>[f.path,f]))
 if(hash(zip)!==m.capsuleSha256 || decoded.length!==m.decodedBytes || entries.size!==m.files.length) errors.push(`capsule-envelope:${name}`)
 for(const f of m.files){
  const b=Buffer.from(entries.get(f.path)?.base64??'','base64')
  if(hash(b)!==f.sha256 || b.length!==f.bytes) errors.push(`capsule-entry:${name}:${f.path}`)
  if(f.source){
   const blob=git(['rev-parse',`${commit}:${f.source}`])
   const original=execFileSync('git',['cat-file','blob',blob],{cwd:root,windowsHide:true})
   if(f.gitBlob!==blob || !b.equals(original)) errors.push(`capsule-source:${name}:${f.path}`)
  } else {
   const match=/^node_modules\/(chokidar|readdirp)\/(.+)$/.exec(f.path)
   if(!match || !b.equals(fs.readFileSync(path.join(dependencyRoots[match[1]],match[2])))) errors.push(`capsule-dependency:${name}:${f.path}`)
  }
 }
 capsules.push({name,commit,files:m.files.length,gitSourceFiles:m.files.filter(f=>f.source).length,localDependencyFiles:m.files.filter(f=>!f.source).length,sha256:hash(zip)})
}
const result={time:new Date().toISOString(),base:binding.base,head:binding.head,sourceFiles:binding.files.length,changedFiles:changed.length,capsules,passed:testReport.numPassedTests,failed:testReport.numFailedTests,total:testReport.numTotalTests,baselineFailures:oldFailures.length,newFailures,resolved,commands:commands.map(c=>({label:c.label,exit:c.exit,start:c.start,end:c.end})),errors}
fs.writeFileSync(new URL('./root-audit.json',import.meta.url),JSON.stringify(result,null,2)+'\n')
console.log(JSON.stringify({sourceFiles:result.sourceFiles,passed:result.passed,failed:result.failed,newFailures:newFailures.length,resolved:resolved.length,errors}))
process.exitCode=errors.length?1:0
