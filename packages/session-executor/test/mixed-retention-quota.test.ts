import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { it } from 'vitest'
import { nativeFixture, inventory, total, save, sha } from './helpers/mixed-retention-fixture.mts'
import { mixedAdmissionProbe } from './helpers/mixed-retention-native-probe.mts'

it('counts genuine legacy/index and managed storage in both quota directions, retaining truthful full/partial/none',async()=>{
  const f=await nativeFixture('q')
  try {
    const legacy=(await f.legacy('a','first','literal copper '+ 'c'.repeat(30000)))!
    assert(legacy.complete);const initial=await inventory(f.ownedRoot), occupied=total(initial)
    await f.service.configure({maxDiskBytes:occupied+196607})
    const refusedScope=f.service.registerResultScope({operationId:'sequential-refused',sessionId:'a',callId:'sequential-refused',documentId:'a',source:await f.runtime.sourceFor('a')},()=>true)
    await assert.rejects(f.service.beginResult(refusedScope,'text-utf8-v1'),{code:'ARTIFACT_QUOTA'})
    assert.deepEqual(await inventory(f.ownedRoot),initial)
    await f.service.configure({maxDiskBytes:2097152})
    const managed=await f.task('a','quota-managed',80000)
    const staged=await f.task('a','quota-staged',70000,true)
    const protectedFiles=await inventory(f.managed), beforePartial=total(await inventory(f.ownedRoot))
    const partialQuota=beforePartial+32768+3000
    await f.service.configure({maxDiskBytes:partialQuota})
    const original='partial silver '+ 's'.repeat(5000),partial=(await f.legacy('a','partial',original))!
    assert(partial);assert.equal(partial.complete,false);assert.equal(partial.originalBytes,Buffer.byteLength(original));assert(partial.bytes>0&&partial.bytes<=1000)
    const partialBody=await fs.readFile(join(f.ownedRoot,'blobs',partial.id+'.txt'))
    assert.deepEqual(partialBody,Buffer.from(original).subarray(0,partial.bytes));assert.equal(sha(partialBody),partial.revision)
    const current=total(await inventory(f.ownedRoot));assert(current<=partialQuota)
    await f.service.configure({maxDiskBytes:current+32768})
    assert.equal(await f.legacy('a','none','new nonempty literal'),undefined)
    const ownersPath=join(f.ownedRoot,'owners',legacy.id+'.json'),beforeGrant=await fs.readFile(ownersPath)
    await f.service.configure({maxDiskBytes:current+1})
    await assert.rejects(f.service.grant({sessionId:'a'},[legacy.id],'b'),/quota/)
    assert.deepEqual(await fs.readFile(ownersPath),beforeGrant)
    assert.deepEqual(await inventory(f.managed),protectedFiles)
    await f.service.configure({maxDiskBytes:2097152})
    const full=(await f.legacy('a','raised','literal platinum '+ 'p'.repeat(20000)))!
    assert(full.complete);assert.equal(full.bytes,full.originalBytes)
    assert.equal((await f.service.search({sessionId:'a'},{query:'platinum'})).hits[0]!.ref.id,full.id)
    assert.equal((await f.service.reconcileResult(staged.operation.owner.operationId,staged.ref.id)).kind,'recovery-required')
    await save(f.root,'sequential-quota',{initial,occupied,managed:managed.ref,staged:staged.ref,stagedPhysicalBytes:total(staged.own),partialQuota,partial,partialBodySha256:sha(partialBody),none:true,grantRefused:true,full,finalPhysicalBytes:total(await inventory(f.ownedRoot)),protectedUnchanged:true,observation:'native service quota/storage; original tasks used for committed and staged protected results'})
  } finally { await f.close() }
},60000)

it('positively calibrates delegated legacy pre/post accounting and managed reserve/write boundaries without holds',async()=>{
  const f=await nativeFixture('c')
  let probe:Awaited<ReturnType<typeof mixedAdmissionProbe>>|undefined
  try {
    // Initialize real SQLite before native-I/O calibration; no mock FTS or filesystem.
    assert(await f.legacy('a','fts','literal calibration baseline'))
    probe=await mixedAdmissionProbe(f.ownedRoot,async(_path,native)=>native())
    const managed=await f.task('a','calibration',70000)
    const legacy=(await f.legacy('a','native-full','literal native beryl '+ 'b'.repeat(2000)))!
    assert(legacy.complete)
    const body=probe.events.findIndex(row=>row.kind==='managed-before-native-body')
    assert(body>0);assert(probe.events.slice(0,body).some(row=>row.kind==='managed-native-lstat'))
    const blob=probe.events.findIndex(row=>row.kind==='legacy-before-native-blob'),blobDone=probe.events.findIndex(row=>row.kind==='legacy-after-native-blob')
    assert(blob>body&&blobDone>blob)
    assert(probe.events.slice(body,blob).some(row=>row.kind==='legacy-native-stat'))
    assert(probe.events.slice(blobDone+1).some(row=>row.kind==='legacy-native-stat'))
    await save(f.root,'native-calibration',{events:probe.events,managed:managed.ref,legacy,delegatedNativeSuccess:true,holds:0,physicalBytes:total(await inventory(f.ownedRoot))})
  } finally {probe?.restore();await f.close()}
},60000)

it('qualifies a fixed-budget mixed admission schedule at real asynchronous native accounting/write boundaries',async()=>{
  const f=await nativeFixture('r')
  let release!:()=>void, arrived!:()=>void, probe:Awaited<ReturnType<typeof mixedAdmissionProbe>>|undefined
  const held=new Promise<void>(done=>{release=done}),boundary=new Promise<void>(done=>{arrived=done})
  let writing:Promise<void>|undefined
  try {
    const legacy=(await f.legacy('a','calibrate','literal calibration zircon'))!
    assert(legacy.complete)
    const older=await f.task('b','protected',70000), protectedFiles=await inventory(f.managed)
    let selected=false
    probe=await mixedAdmissionProbe(f.ownedRoot,async(_path,native)=>{
      if(!selected){selected=true;arrived();await held}
      return native()
    })
    const scope=f.service.registerResultScope({operationId:'mixed-admission',sessionId:'a',callId:'mixed-admission',documentId:'a',source:await f.runtime.sourceFor('a')},()=>true)
    const sink=await f.service.beginResult(scope,'text-utf8-v1')
    const initial=total(await inventory(f.ownedRoot)), quota=initial+240000
    await f.service.configure({maxDiskBytes:quota})
    writing=sink.write(Buffer.alloc(65536,109))
    let timer:ReturnType<typeof setTimeout>|undefined
    try { await Promise.race([boundary,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('native body boundary not reached')),10000);timer.unref()})]) }
    finally { clearTimeout(timer) }
    assert(probe.events.some(row=>row.kind==='managed-native-lstat'))
    const beforeLegacy=total(await inventory(f.ownedRoot)), original='literal concurrent jasper '+ 'j'.repeat(200000)
    const incoming=await f.legacy('a','concurrent',original)
    const afterLegacy=total(await inventory(f.ownedRoot))
    assert(probe.events.some(row=>row.kind==='legacy-native-stat'))
    assert(probe.events.some(row=>row.kind==='legacy-before-native-blob'))
    assert(probe.events.some(row=>row.kind==='legacy-after-native-blob'))
    if(incoming){const actual=await fs.readFile(join(f.ownedRoot,'blobs',incoming.id+'.txt'));assert.deepEqual(actual,Buffer.from(original).subarray(0,incoming.bytes));assert.equal(incoming.complete,incoming.bytes===Buffer.byteLength(original))}
    release();await writing
    const afterWrite=total(await inventory(f.ownedRoot)), settlement=await sink.finish('complete'), finalFiles=await inventory(f.ownedRoot),finalBytes=total(finalFiles)
    const sampledPeak=Math.max(initial,beforeLegacy,afterLegacy,afterWrite,finalBytes,...probe.events.map(row=>row.physicalBytes??0))
    const remainingTemporary=Object.keys(finalFiles).filter(path=>path.endsWith('.pending')||path.endsWith('.tmp')||path.endsWith('-journal'))
    const oldCurrent=await inventory(join(f.managed,older.ref.id));assert.deepEqual(oldCurrent,older.own)
    await save(f.root,'mixed-schedule',{quota,initial,beforeLegacy,afterLegacy,afterWrite,finalBytes,sampledPeak,peakMeaning:'boundary samples only; unobserved synchronous SQLite journal writes not a global maximum',documentedTemporaryAllowance:'none in retained-results physical-budget contract',legacyDisposition:incoming?(incoming.complete?'full':'partial'):'none',incoming,managedSettlement:settlement,events:probe.events,remainingTemporary,protectedFiles,protectedUnchanged:true,actualNativeAsyncHold:true,sqliteSynchronousWorkUnmodified:true})
    assert(finalBytes<=quota,'final physical mixed occupancy must respect fixed budget')
    // A new legacy item may be refused/rolled back and a managed finish may
    // refuse honestly; neither disposition is by itself a shared-quota breach.
    assert(afterWrite<=quota,'managed native body growth must respect its admitted physical budget')
  } finally {release();if(writing)await Promise.allSettled([writing]);probe?.restore();await f.close()}
},60000)

it('accepts live lowering below existing managed occupancy before legacy opens, preserving reads and refusing growth',async()=>{
  const f=await nativeFixture('u')
  try {
    const original=await f.task('a','unopened',90000),before=await inventory(f.ownedRoot),occupied=total(before)
    assert(occupied>65536);await assert.rejects(fs.stat(join(f.ownedRoot,'index.sqlite')),{code:'ENOENT'})
    const lowered=await f.service.configure({maxDiskBytes:65536})
    assert.equal(lowered.config.maxDiskBytes,65536);assert.deepEqual(await inventory(f.ownedRoot),before)
    const page=await f.service.readResult({sessionId:'a'},{ref:original.ref,maxBytes:4096})
    assert(page.data.kind==='text');assert.equal(page.data.text,original.expected.subarray(0,Buffer.byteLength(page.data.text)).toString())
    const scope=f.service.registerResultScope({operationId:'no-growth',sessionId:'a',callId:'no-growth',source:await f.runtime.sourceFor('a')},()=>true)
    await assert.rejects(f.service.beginResult(scope,'text-utf8-v1'),{code:'ARTIFACT_QUOTA'})
    assert.deepEqual(await inventory(f.ownedRoot),before)
    await save(f.root,'unopened-lowering',{occupied,lowered,existingReadBytes:Buffer.byteLength(page.data.text),legacyNeverOpened:true,newGrowthRefused:true,unchanged:before})
  }finally{await f.close()}
},60000)
