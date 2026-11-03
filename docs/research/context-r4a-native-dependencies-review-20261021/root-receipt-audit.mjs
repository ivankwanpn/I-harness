import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {createHash} from 'node:crypto'
const root=process.cwd(), evidence=path.join(root,'.tmp/context-r4a-native-dependencies-20261021-implementation')
const work=path.join(root,'.superpowers/sdd/2026-10-21-context-r4a-native-dependencies')
const read=p=>JSON.parse(fs.readFileSync(path.join(evidence,p),'utf8'))
const hash=b=>createHash('sha256').update(b).digest('hex')
const index=read('evidence-index.json')
const result={head:'cfa3d5ee8b899e4b31f9870ff1cb1cb86eadd87a',failures:[],checks:[]}
const selected=name=>index.receipts.filter(r=>r.externalCopy&&r.path.endsWith(name))
function check(name,fn){try{fn();result.checks.push({name,passed:true})}catch(e){result.failures.push({name,message:e.message,stack:e.stack})}}
function actualBody(fixture,ref){
  const base=path.join(evidence,fixture)
  function walk(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):[path.join(dir,e.name)])}
  const found=walk(base).filter(p=>p.endsWith(path.sep+ref.id+path.sep+'body'))
  assert.equal(found.length,1)
  const bytes=fs.readFileSync(found[0]);assert.equal(bytes.length,ref.encodedBytes);assert.equal(hash(bytes),ref.contentDigest);return bytes
}
function framePayload(bytes){
  assert.equal(bytes.subarray(0,9).toString(),'IHEXEC01\n')
  const rows=bytes.subarray(9).toString().trim().split('\n').map(JSON.parse)
  for(const r of rows)assert.equal(Buffer.from(r.data,'base64').toString('base64'),r.data)
  return rows.map(r=>({channel:r.channel,frame:r.frame,offset:r.offset,end:r.end,bytes:Buffer.from(r.data,'base64')}))
}
check('Four-artifact lifecycle and independent primary digest',()=>{
  const [row]=selected('lifecycle-receipt.json'),v=read(row.path)
  assert.equal(v.refs.length,4);assert.equal(v.before.length,4);assert.equal(new Set(v.refs.map(r=>r.id)).size,4)
  assert.deepEqual(v.nativeExits,[5,0]);assert.equal(v.bodies,1);assert.equal(v.getters,1);assert.equal(v.launches,2)
  for(const r of v.before){assert.equal(r.operation.phase,'committed');assert.equal(r.pins.length,1);assert(v.refs.some(ref=>ref.id===r.operation.id))}
  const [primary,,first,second]=v.refs
  assert(primary.encodedBytes>60000);assert.equal(first.codec,'exec-frames-v1');assert.equal(second.codec,'exec-frames-v1')
  const expected=Buffer.from(JSON.stringify({firstExit:5,secondExit:0,padding:'m'.repeat(70000),sourceId:'payload-not-source',dependencies:[{sourceId:'fake'}],entries:['data'],ref:{kind:'artifact',ref:second}}))
  assert.equal(primary.encodedBytes,expected.length);assert.equal(primary.contentDigest,hash(expected))
  assert.equal(v.freshStoreDistinct,true);assert.equal(v.retainedFreshDeletionObserver,true);assert.deepEqual(v.finalInventory,[])
  assert.equal(fs.readFileSync(path.join(evidence,path.dirname(row.path),'native-effects.jsonl'),'utf8'),'first\nsecond\n')
  result.primary={bytes:expected.length,sha256:hash(expected),bodyAvailability:'Deletion intentionally removed all four bodies; root checks preserved identity against independent literal primary, not a new post-deletion read'}
})
check('Genuine observer exact identities and scoped lifecycle receipt',()=>{
  const [row]=selected('observer-receipt.json'),v=read(row.path)
  assert.notEqual(v.parent,v.childId);assert.equal(v.operation.owner.sessionId,v.childId)
  assert.equal(v.targetPin.sessionId,v.parent);assert.equal(v.targetPin.documentId,v.parent)
  assert.equal(v.targetPin.operationId,v.operation.owner.operationId);assert.equal(v.targetPin.revision,v.frame.revision)
  assert.deepEqual(v.operation.ref,v.frame);assert.equal(v.operation.phase,'committed')
  assert.equal(v.originSource.sourceId,v.targetSource.sourceId)
  assert.equal(v.barePage.kind,'unavailable');assert.equal(v.barePage.reason,'unauthorized')
  assert.deepEqual(v.page.ref,v.frame);assert.deepEqual(v.originPage.ref,v.frame)
  assert.equal(v.launches,1);assert.equal(v.nativeExit,0);assert.equal(v.catalog.count,1)
  assert.equal(v.parentResult.callId,'parent-observe-terminal');assert.deepEqual(v.parentResult.envelope.dependencies,v.catalog)
  assert.equal(v.toolRead.name,'context_output_read');assert.equal(v.toolRead.envelope.retention.kind,'inline')
  assert.deepEqual(v.toolRead.envelope.retention.value.ref,v.frame)
  assert.notEqual(v.catalog.ref.id,v.secondCatalog.id);assert.deepEqual(v.secondResult.envelope.dependencies.ref,v.secondCatalog)
  assert(v.secondAttempts>1)
  for(const k of ['siblingDenied','distinctFreshStore','archiveDuringRead','rewindDuringRead','selectiveRewind','deletionInterrupted','targetDeletedFrameAbsent'])assert.equal(v[k],true,k)
  const first=Buffer.concat(v.page.frames.map(x=>Buffer.from(x.data,'base64')))
  assert(first.length>0);assert(first.every(x=>x===97))
  assert(Buffer.byteLength(JSON.stringify(v.page))<=4096)
  result.observer={receipt:row.path,frame:v.frame.id,catalogs:[v.catalog.ref.id,v.secondCatalog.id],nativeLaunches:1,claims:'Preserved original source and test assertions, not a new runtime invocation or a claim of known-refused C2 coverage'}
})
for(const mode of ['source','catalog']){
  check('Original '+mode+' acknowledgement unknown and same-operation recovery',()=>{
    const row=index.receipts.find(r=>r.externalCopy&&r.path.includes('/uncertain-'+mode+'-')&&r.path.endsWith('/pending-checkpoint.json'))
    assert(row)
    const pending=read(row.path),dir=path.dirname(row.path),done=read(dir+'/recovered-receipt.json')
    assert.equal(pending.mode,mode);assert.equal(pending.noF1,true);assert(pending.finalizerEntries>0&&pending.attempts>0)
    assert.equal(done.selected.operationId,pending.selected.operationId)
    assert.equal(done.bodies,1);assert.equal(done.launches,2);assert(done.attempts>1)
    assert.equal(done.result.envelope.dependencies.kind,'artifact-set');assert.equal(done.result.envelope.dependencies.count,2)
    assert.equal(done.inventory.filter(r=>r.operation.codec==='exec-frames-v1'&&r.operation.phase==='committed').length,2)
    assert.equal(fs.readFileSync(path.join(evidence,dir,'native-effects.jsonl'),'utf8'),'source-0\nsource-1\n')
    for(const inv of done.inventory){
      const ref=inv.operation.ref;assert(ref)
      const bytes=actualBody(dir,ref)
      if(ref.codec==='exec-frames-v1'){
        const payload=Buffer.concat(framePayload(bytes).map(x=>x.bytes)).toString()
        assert(['source-0','source-1'].includes(payload))
      }else{
        const catalog=JSON.parse(bytes);assert.equal(catalog.kind,'result-dependencies');assert.equal(catalog.entries.length,2)
      }
    }
  })
}
for(const mode of ['unknown','quota']){
  check('Membership '+mode+' actual boundary and retained original result',()=>{
    const row=index.receipts.find(r=>r.externalCopy&&r.path.includes('/membership-'+mode+'-')&&r.path.endsWith('/membership-receipt.json'))
    assert(row);const v=read(row.path),dir=path.dirname(row.path)
    assert.equal(v.bodies,1);assert.equal(v.launches,2)
    assert.deepEqual(v.result.envelope.execution,{outcome:'succeeded',dispatch:'dispatched'})
    assert.deepEqual(v.result.envelope.retention.value,{independentPrimary:true,nativeExits:[0,0]})
    assert.equal(v.result.envelope.dependencies.count,2)
    assert.equal(fs.readFileSync(path.join(evidence,dir,'native-effects.jsonl'),'utf8'),'native-0\nnative-1\n')
    if(mode==='unknown'){
      const cut=read(dir+'/partial-membership-receipt.json'),pending=read(dir+'/pending-membership-checkpoint.json')
      assert.equal(cut.partialCount,1);assert.equal(cut.operationId,v.operationId);assert.equal(pending.operationId,v.operationId)
      assert.equal(pending.noF1,true);assert.equal(pending.ownFrameStillRequiresVisibleCatalog,true)
      assert(v.attempts>1);assert.equal(v.result.envelope.dependencies.kind,'artifact-set')
    }else{
      assert.equal(v.quotaCalibration.quota,v.quotaCalibration.physical+1)
      assert.equal(v.quotaCalibration.reserveRequiresAtLeast,131072)
      assert.deepEqual(v.result.envelope.dependencies,{kind:'unavailable',reason:'quota',count:2})
    }
    assert.equal(v.inventory.length,3);assert(v.inventory.every(x=>x.operation.phase==='committed'))
    for(const inv of v.inventory)actualBody(dir,inv.operation.ref)
  })
}
check('Known source, catalog refusal and independent completeness',()=>{
  const source=selected('refusal-receipt.json').find(r=>r.path.includes('/known-source-refusal-'))
  const catalog=selected('refusal-receipt.json').find(r=>r.path.includes('/known-catalog-refusal-'))
  assert(source&&catalog)
  const s=read(source.path),c=read(catalog.path)
  assert.equal(s.native[0].exitCode,5);assert.equal(s.native[1].exitCode,0);assert.equal(s.native[1].retentionFailure,'unavailable')
  assert.equal(s.catalog.entries[0].retention.ref.completeness,'complete')
  assert.equal(s.catalog.entries[1].retention.kind,'unavailable');assert.equal(s.catalog.entries[1].retention.reason,'quota')
  assert.equal(s.result.envelope.dependencies.ref.completeness,'source-limited')
  assert.equal(s.calibration.quota,s.calibration.physical+210000)
  assert.equal(c.calibration.quota,c.calibration.physical+196607);assert.equal(c.calibration.beginReserve,196608)
  assert.deepEqual(c.result.envelope.dependencies,{kind:'unavailable',reason:'quota',count:2})
  const [complete]=selected('completeness-receipt.json'),v=read(complete.path)
  assert.equal(v.native.complete.exitCode,5);assert.equal(v.native.complete.timedOut,false)
  assert.deepEqual(v.native.limited.stream.bytesAdmitted,{stdout:1,stderr:0});assert.equal(v.native.limited.stream.stopReason,'output-limit')
  assert(v.native.limited.outputDiagnostics.discardedOutputBytes>0)
  assert.equal(v.catalog.entries[0].retention.ref.completeness,'complete')
  assert.equal(v.catalog.entries[1].retention.ref.completeness,'producer-incomplete')
  assert.equal(v.result.envelope.dependencies.ref.completeness,'source-limited')
})
check('Original storage owner and current-policy seam receipts',()=>{
  const [row]=selected('owner-seam-receipt.json'),v=read(row.path)
  for(const key of ['originalOwnerCloned','originalEntriesCloned','missingPinDidNotGrant','monotonicOriginalScopeRevoked'])assert.equal(v[key],true)
  assert.deepEqual(v.originalRecord.memberRef,v.frame);assert.deepEqual(v.originalRecord.catalogRef,v.catalog)
  assert.equal(v.originalRecord.sourceId,'native-source-identity')
  const [policy]=selected('catalog-policy-receipt.json'),p=read(policy.path)
  assert.notEqual(p.currentSource.sourceId,p.catalogCapturedSource)
  result.policyScope='Same-session actual native registration plus host-authored B catalog and real managed delivery; no full Agent source-switch/exploit claim'
})
result.limitations=[
  'Deleted lifecycle/observer bodies cannot be newly re-read; preserved refs, original assertions/logs and independent primary literal are used honestly.',
  'This audit reads sealed evidence only. It neither reruns runtime controls nor closes the independent reviewer two P2 qualification gaps.',
  'Native source IDs/ordinals and local host metadata are semantic records, not cryptographic defense against arbitrary coherent local rewriting.',
]
fs.writeFileSync(path.join(work,'root-receipt-audit.json'),JSON.stringify(result,null,2)+'\n')
console.log(JSON.stringify(result,null,2))
if(result.failures.length)process.exitCode=1
