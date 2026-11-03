import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
const root=process.cwd(),work=path.join(root,'.superpowers/sdd/2026-10-21-context-r4a-native-dependencies')
const old=path.join(root,'.tmp/context-r4a-native-dependencies-20261021-implementation'),fresh=path.join(root,'.tmp/r4a-native-fix1-20261021')
const json=p=>JSON.parse(fs.readFileSync(p,'utf8')),read=n=>json(path.join(fresh,n))
const sha=b=>createHash('sha256').update(b).digest('hex')
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',maxBuffer:16*1024*1024}).trim()
const out={head:'382864914331931f6b04502501a86153cce02204',failures:[]}
function verify(p,r){const b=fs.readFileSync(p);assert.equal(b.length,r.bytes,p);assert.equal(sha(b),r.sha256,p)}
function walk(d){return fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>{assert(!e.isSymbolicLink());const p=path.join(d,e.name);return e.isDirectory()?walk(p):[p]})}
function sealed(dir,expected){
  const seal=json(path.join(dir,'evidence-seal.json'));assert.equal(sha(fs.readFileSync(path.join(dir,'evidence-seal.json'))),expected)
  const names=walk(dir).map(p=>path.relative(dir,p).replaceAll('\\','/')).filter(p=>p!=='evidence-seal.json').sort()
  assert.deepEqual(names,seal.files.map(r=>r.path.replaceAll('\\','/')).sort())
  let bytes=0;for(const r of seal.files){const p=path.resolve(dir,r.path);assert(p.startsWith(dir+path.sep));verify(p,r);bytes+=r.bytes}
  return{files:seal.files.length,bytes,sha256:expected}
}
const diff=(a,b)=>{const aa=new Map(a.map(r=>[r.path,r.sha256])),bb=new Map(b.map(r=>[r.path,r.sha256]));return [...new Set([...aa.keys(),...bb.keys()])].filter(p=>aa.get(p)!==bb.get(p)).sort()}
try{
  assert.equal(git('rev-parse','HEAD'),out.head);assert.equal(git('status','--porcelain'),'')
  const h=json(path.join(work,'fix1-handback.json'));assert.equal(h.head,out.head)
  out.handbackSha256=sha(fs.readFileSync(path.join(work,'fix1-handback.json')))
  assert.equal(sha(fs.readFileSync(h.report.path)),h.report.sha256)
  out.seal=sealed(fresh,h.evidence.sealSha256)
  out.oldSeal=sealed(old,h.oldImmutable.hashes.seal)
  assert.equal(sha(fs.readFileSync(path.join(work,'task-1-report.md'))),h.oldImmutable.hashes.report)
  assert.equal(sha(fs.readFileSync(path.join(work,'task-1-handback.json'))),h.oldImmutable.hashes.handback)
  const source=read(h.evidence.sourceManifest).files,previous=json(path.join(old,'final-freeze-manifest.json')).files
  assert.equal(sha(fs.readFileSync(path.join(fresh,h.evidence.sourceManifest))),h.evidence.sourceManifestSha256)
  for(const r of source)verify(path.join(root,r.path),r)
  const sourceDelta=read('source-delta.json'),oldNames=new Set(previous.map(r=>r.path))
  assert.deepEqual(diff(previous,source.filter(r=>oldNames.has(r.path))),sourceDelta.changedPaths)
  const additions=source.filter(r=>!oldNames.has(r.path));assert.deepEqual(additions.map(r=>r.path).sort(),sourceDelta.addedManifestPaths)
  assert.equal(additions.length,8)
  let extraFixtures=0
  for(const r of additions.filter(r=>r.path.startsWith('packages/'))){
    const blob=execFileSync('git',['show',h.base+':'+r.path],{cwd:root,maxBuffer:1024*1024})
    const current=fs.readFileSync(path.join(root,r.path))
    assert.equal(blob.toString('utf8').replaceAll('\r\n','\n'),current.toString('utf8').replaceAll('\r\n','\n'),r.path+' preexisting fixture content')
    extraFixtures++
  }
  assert.equal(extraFixtures,6)
  assert.deepEqual(git('diff','--name-only',`${h.base}..${h.head}`).split('\n').sort(),sourceDelta.changedPaths)
  const afterProduct=git('diff','--name-only',`${h.productUnchangedFrom}..${h.head}`,'--','packages','apps').split('\n').filter(Boolean)
  assert(afterProduct.every(p=>p.includes('/test/')))
  out.source={files:source.length,changedTests:sourceDelta.changedPaths,addedManifestInputs:sourceDelta.addedManifestPaths,preexistingHiddenFixtureContentsVerified:extraFixtures,productChanges:0}
  const gates=[]
  for(const name of h.verification.finalGates){
    const receipt=read(name+'-exit.json'),beforeName=name+'-before-sources.json',afterName=name+'-after-sources.json'
    assert.equal(receipt.nativeExit,0);assert.deepEqual(receipt.sourceChanges,[])
    for(const [name,key] of [[beforeName,'beforeManifestSha256'],[afterName,'afterManifestSha256']])assert.equal(sha(fs.readFileSync(path.join(fresh,name))),receipt[key])
    const before=read(beforeName).files,after=read(afterName).files
    assert.deepEqual(diff(before,after),[]);assert.deepEqual(diff(after,source),[])
    assert.equal(receipt.environment.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT,fresh)
    assert.equal(receipt.environment.IH_CONFIG_DIR,path.join(fresh,'config'))
    const log=fs.readFileSync(path.join(fresh,name+'.log'),'utf8').replace(/\x1b\[[0-9;]*m/g,'')
    if(name!=='fix1-types')assert(/\b1 passed\b/.test(log),name)
    else {
      assert(receipt.arguments.includes('@i-harness/session-executor')&&receipt.arguments.includes('@i-harness/sdk'))
      assert(receipt.arguments.includes('--workspace-concurrency=1'))
      assert.deepEqual(log.trim().split(/\r?\n/).map(line=>line.trim()).filter(Boolean),['$ tsc --noEmit','$ tsc --noEmit'])
    }
    gates.push({name,nativeExit:0,start:receipt.nativeStartedAt,end:receipt.nativeFinishedAt,sourceChanges:0})
  }
  const order=[...gates].sort((a,b)=>Date.parse(a.start)-Date.parse(b.start));for(let i=1;i<order.length;i++)assert(Date.parse(order[i-1].end)<=Date.parse(order[i].start))
  out.gates=gates
  const idx=read('fix1-index.json'),later=read(idx.latestObserver+'/later-refusal-receipt.json'),observer=read(idx.latestObserver+'/observer-receipt.json')
  assert.equal(later.refusalCalibration.quota,later.refusalCalibration.physical+1);assert.equal(later.refusalCalibration.reserveAtLeast,131072)
  assert.deepEqual(later.refusedResult.envelope.dependencies,{kind:'unavailable',reason:'quota',count:1})
  assert.deepEqual(later.refusedResult.envelope.execution,observer.parentResult.envelope.execution)
  assert.deepEqual(later.refusedResult.envelope.retention,observer.parentResult.envelope.retention)
  assert.deepEqual(later.c1BeforeRefusal.frame,observer.frame);assert.deepEqual(later.c1BeforeRefusal.catalog,observer.catalog.ref)
  assert.equal(later.c1Preserved,true);assert.equal(later.laterCompanionAbsent,true);assert.equal(later.nativeBodies,1);assert.equal(later.launches,1)
  assert.equal(later.nativeLedger,'native-child\n')
  assert.equal(fs.readFileSync(path.join(fresh,idx.latestObserver,'native-effects.jsonl'),'utf8'),'native-child\n')
  const cli=read(idx.latestCli+'/cli-witness-receipt.json'),closed=read(idx.latestCli+'/cleanup.json')
  assert.equal(cli.pages.length,5);assert.equal(cli.malformedRpcCode,-32602);assert.equal(cli.unrelatedWitnessDenied,true);assert.equal(cli.sessionBytesUnchanged,true)
  assert.equal(closed.originalCliProcess,cli.pid);assert.deepEqual(closed.nativeExit,{code:0,signal:null});assert.equal(closed.closed,true)
  const outputs={stdout:[],stderr:[]},ends=new Set();let cursor,previousFrame=-1
  for(let i=0;i<cli.pages.length;i++){
    const page=cli.pages[i];assert.deepEqual(page.ref,cli.frame);assert(Buffer.byteLength(JSON.stringify(page))<=4096)
    if(cursor)assert.deepEqual(page.cursor,cursor)
    for(const part of page.frames){
      assert(part.frame>=previousFrame);assert.equal(part.channel,part.frame===0?'stdout':'stderr');assert(!ends.has(part.frame))
      previousFrame=part.frame
      const chunks=outputs[part.channel],bytes=Buffer.from(part.data,'base64');assert.equal(bytes.toString('base64'),part.data)
      assert.equal(part.offset,chunks.reduce((n,b)=>n+b.length,0));chunks.push(bytes);if(part.end)ends.add(part.frame)
    }
    if(i===cli.pages.length-1){assert.equal(page.eof,true);assert.equal(page.nextCursor,null)}
    else{assert.equal(page.eof,false);assert(page.nextCursor);assert.notDeepEqual(page.nextCursor,page.cursor)}
    cursor=page.nextCursor
  }
  const stdout=Buffer.concat(outputs.stdout),stderr=Buffer.concat(outputs.stderr)
  const expected=Buffer.concat([Buffer.from([0,255,127]),Buffer.from('😀'),Buffer.alloc(12000,97)])
  assert.deepEqual(stdout,expected);assert.deepEqual(stderr,Buffer.from('CLI-end'));assert.deepEqual([...ends],[0,1])
  assert.equal(sha(stdout),cli.expectedStdoutSha256);assert.equal(sha(stderr),cli.expectedStderrSha256)
  const artifactFiles=walk(path.join(fresh,idx.latestCli))
  for(const ref of [cli.frame,cli.catalog,cli.unrelated]){
    const matches=artifactFiles.filter(p=>p.endsWith(path.sep+ref.id+path.sep+'body'));assert.equal(matches.length,1)
    const b=fs.readFileSync(matches[0]);assert.equal(b.length,ref.encodedBytes);assert.equal(sha(b),ref.contentDigest)
    const operation=json(path.join(path.dirname(matches[0]),'operation.json'));assert.deepEqual(operation.ref,ref);assert.equal(operation.phase,'committed')
  }
  out.laterRefusal={physical:later.refusalCalibration.physical,quota:later.refusalCalibration.quota,count:1,nativeEffects:1,seam:'Genuine later membership quota after committed catalog; preserved C1 original assertions/bytes and receipt'}
  out.cli={pid:cli.pid,exit:closed.nativeExit,pages:5,stdoutBytes:stdout.length,stderrBytes:stderr.length,stdoutSha256:sha(stdout),stderrSha256:sha(stderr),rawArtifactBodiesRehashed:3}
  const cleanup=read('cleanup-inventory.json');assert.equal(cleanup.count,0);assert.deepEqual(cleanup.matchingOwnedNodes,[])
  for(const r of cleanup.fixtureCleanupReceipts)assert.deepEqual(read(r.path),r.receipt)
  assert.equal(cleanup.fixtureCleanupReceipts.length,4)
  out.cleanup={receipts:4,matchingOwnedNodeProcesses:0}
  out.limits=['Earlier 98-test/nine-type gates are preserved, not repeated or summed as new tests.','Six hidden fixtures are newly covered manifest inputs; original groups did not independently hash those paths. Their current content matches the prior Git revision apart from permitted EOL representation.','Actual CLI is cold transport/storage-owner qualification, separate from genuine native producer observer.','Original profile-isolation and deep-root SQLite limitations remain.']
  assert.equal(git('rev-parse','HEAD'),out.head);assert.equal(git('status','--porcelain'),'')
}catch(e){out.failures.push({message:e.message,stack:e.stack})}
fs.writeFileSync(path.join(work,'root-fix1-audit-v2.json'),JSON.stringify(out,null,2)+'\n')
console.log(JSON.stringify(out,null,2));if(out.failures.length)process.exitCode=1
