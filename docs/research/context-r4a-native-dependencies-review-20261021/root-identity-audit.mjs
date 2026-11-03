import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
const root=process.cwd(), work=path.join(root,'.superpowers/sdd/2026-10-21-context-r4a-native-dependencies')
const evidence=path.join(root,'.tmp/context-r4a-native-dependencies-20261021-implementation')
const read=file=>JSON.parse(fs.readFileSync(file,'utf8')), load=name=>read(path.join(evidence,name))
const hash=value=>createHash('sha256').update(value).digest('hex')
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',maxBuffer:16*1024*1024}).trim()
const result={head:'cfa3d5ee8b899e4b31f9870ff1cb1cb86eadd87a',checkedAt:new Date().toISOString(),failures:[]}
function verify(file,row){const b=fs.readFileSync(file);assert.equal(b.length,row.bytes,file);assert.equal(hash(b),row.sha256,file)}
function map(rows){assert.equal(new Set(rows.map(r=>r.path)).size,rows.length);return new Map(rows.map(r=>[r.path,r]))}
function changes(a,b){const aa=map(a),bb=map(b);return [...new Set([...aa.keys(),...bb.keys()])].filter(p=>aa.get(p)?.sha256!==bb.get(p)?.sha256||aa.get(p)?.bytes!==bb.get(p)?.bytes).sort()}
function files(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>{const p=path.join(dir,e.name);assert(!e.isSymbolicLink());return e.isDirectory()?files(p):[p]})}
try{
  assert.equal(git('rev-parse','HEAD'),result.head);assert.equal(git('status','--porcelain'),'')
  const h=read(path.join(work,'task-1-handback.json'));assert.equal(h.head,result.head)
  result.base=h.base;result.handbackSha256=hash(fs.readFileSync(path.join(work,'task-1-handback.json')))
  for(const item of [h.report,h.delivery])assert.equal(hash(fs.readFileSync(item.path)),item.sha256)
  assert.equal(hash(fs.readFileSync(path.join(evidence,h.evidence.seal))),h.evidence.sealSha256)
  const seal=load(h.evidence.seal);assert.equal(seal.head,result.head);assert.equal(seal.base,h.base)
  const actual=files(evidence).map(p=>path.relative(evidence,p).replaceAll('\\','/')).filter(p=>p!==h.evidence.seal).sort()
  assert.deepEqual(actual,seal.files.map(r=>r.path.replaceAll('\\','/')).sort())
  let bytes=0
  for(const row of seal.files){
    const p=path.resolve(evidence,row.path);assert(p.startsWith(evidence+path.sep));verify(p,row);bytes+=row.bytes
  }
  result.seal={files:seal.files.length,bytes,sha256:h.evidence.sealSha256}
  const source=load(h.evidence.sourceManifest).files
  assert.equal(hash(fs.readFileSync(path.join(evidence,h.evidence.sourceManifest))),h.evidence.sourceManifestSha256)
  for(const row of source){const p=path.resolve(root,row.path);assert(p.startsWith(root+path.sep));verify(p,row)}
  result.source={files:source.length,manifestSha256:h.evidence.sourceManifestSha256,mismatches:0}
  const external=load(h.evidence.externalCopyManifest)
  for(const row of external.files){
    assert(row.source.startsWith(root+'\\')||row.source.startsWith(root+'/'))
    verify(row.source,row);verify(path.join(evidence,row.copy),row);assert.equal(row.copySha256,row.sha256)
  }
  assert.deepEqual(external.guardProbeEntries,['evidence-seal.json'])
  assert.deepEqual(external.unexpectedDefaultRootNativeFixtureDirectoriesSinceShortRouteStart,[])
  result.external={copies:external.files.length,sourceAndCopyMismatches:0,guardFiles:external.guardProbeEntries,newDefaultRootFixtures:0}
  const fixtureDelta=git('diff','--name-only',`${h.productRepairHead}..${h.testIsolationHead}`,'--','packages').split('\n').filter(Boolean).sort()
  assert.deepEqual(fixtureDelta,[
    'packages/context-output/test/dependency-membership.test.ts',
    'packages/session-executor/test/native-dependency-fixture.ts',
    'packages/session-executor/test/native-dependency-observer.test.ts',
  ])
  const productPaths=source.filter(r=>(r.path.startsWith('packages/')||r.path.startsWith('apps/'))&&r.path.includes('/src/')).map(r=>r.path)
  // All package/app src files, not only the new leaf.
  const postRepair=git('diff','--name-only',`${h.productRepairHead}..${h.head}`,'--','packages','apps').split('\n').filter(Boolean)
  assert.deepEqual(postRepair,fixtureDelta)
  result.source.productRepairHead=h.productRepairHead;result.source.productSourcePaths=productPaths.length
  result.source.onlyLaterFixtureChanges=fixtureDelta
  const labels=[...h.verification.latestProductGates,...h.verification.testOnlyGates], gates=[]
  const expectedTests={'final-session-policy':33,'final-context-policy':17,'final-sdk-policy':3,'final-gateway-policy':11,'final-desktop-policy':27,'final-tool-owner':6,'final-exec-owner':1,'final-isolated-session-short':11,'final-isolated-context':1}
  for(const label of labels){
    const exit=load(label+'-exit.json'),beforePath=label+'-before-manifest.json',afterPath=label+'-after-manifest.json'
    assert.equal(exit.label,label);assert.equal(exit.nativeExit,0);assert.deepEqual(exit.sourceChanges,[])
    assert.equal(hash(fs.readFileSync(path.join(evidence,beforePath))),exit.beforeManifestSha256)
    assert.equal(hash(fs.readFileSync(path.join(evidence,afterPath))),exit.afterManifestSha256)
    const before=load(beforePath).files,after=load(afterPath).files
    assert.deepEqual(changes(before,after),[])
    const delta=changes(after,source),isIsolation=h.verification.testOnlyGates.includes(label)
    assert.deepEqual(delta,isIsolation?[]:fixtureDelta)
    const times=[exit.startedAt,exit.nativeStartedAt,exit.nativeFinishedAt,exit.finishedAt].map(Date.parse)
    assert(times.every(Number.isFinite));for(let i=1;i<times.length;i++)assert(times[i]>=times[i-1])
    assert(exit.environment.IH_CONFIG_DIR.startsWith(root+'\\')||exit.environment.IH_CONFIG_DIR.startsWith(root+'/'))
    const log=fs.readFileSync(path.join(evidence,label+'.log'),'utf8').replace(/\x1b\[[0-9;]*m/g,'')
    if(expectedTests[label])assert(new RegExp(`\\b${expectedTests[label]} passed\\b`).test(log),label+' exact test count')
    gates.push({label,nativeExit:exit.nativeExit,files:after.length,tests:expectedTests[label],nativeStart:exit.nativeStartedAt,nativeEnd:exit.nativeFinishedAt,finalSourceDelta:delta})
  }
  const ordered=[...gates].sort((a,b)=>Date.parse(a.nativeStart)-Date.parse(b.nativeStart))
  for(let i=1;i<ordered.length;i++)assert(Date.parse(ordered[i-1].nativeEnd)<=Date.parse(ordered[i].nativeStart))
  result.gates=gates
  result.productTestTotal=h.verification.latestProductGates.reduce((n,label)=>n+(expectedTests[label]??0),0);assert.equal(result.productTestTotal,98)
  const guards=[]
  for(const label of h.verification.sealedGuardGates){
    const row=load(label+'-exit.json');assert.equal(row.nativeExit,1)
    const log=fs.readFileSync(path.join(evidence,label+'.log'),'utf8')
    assert(/sealed|Sealed/.test(log));guards.push({label,nativeExit:row.nativeExit})
  }
  result.guardProbes=guards
  const processes=load(h.cleanup.inventory)
  assert.equal(processes.count,0);assert.deepEqual(processes.matchingOwnedNodeProcesses,[])
  for(const row of processes.cleanupReceipts){
    assert.deepEqual(read(row.path),row.receipt)
    assert(row.receipt.ownedJobsClosed===true||row.receipt.allOwnedJobsClosed===true)
  }
  result.cleanup={receipts:processes.cleanupReceipts.length,matchingOwnedNodeProcesses:processes.count,scope:'Recorded task-root scan plus original awaited disposal receipts, not a new system-wide scan'}
  const index=load(h.evidence.index)
  for(const row of index.receipts)verify(path.join(evidence,row.path),row)
  result.receiptIndex={receipts:index.receipts.length,hashMismatches:0}
  result.commandLedgerEntries=load(h.evidence.commands).length
  assert.equal(git('rev-parse','HEAD'),result.head);assert.equal(git('status','--porcelain'),'')
}catch(e){result.failures.push({message:e.message,stack:e.stack})}
fs.writeFileSync(path.join(work,'root-identity-audit.json'),JSON.stringify(result,null,2)+'\n')
console.log(JSON.stringify({...result,gates:result.gates?.map(({label,nativeExit,tests,finalSourceDelta})=>({label,nativeExit,tests,sourceDelta:finalSourceDelta.length}))},null,2))
if(result.failures.length)process.exitCode=1
