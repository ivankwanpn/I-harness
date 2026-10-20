import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { it } from 'vitest'
import { nativeFixture, inventory, total, save, readManaged, sha, sessionArtifactManifest } from './helpers/mixed-retention-fixture.mts'

it('qualifies genuine native mixed storage, saved override, TTL/clear/index and selective document deletion', async () => {
  const f = await nativeFixture('n')
  try {
    assert.equal(f.service.status().config.enabled,true); assert.equal(f.service.status().config.maxDiskBytes,2097152); assert.equal(f.service.status().config.retentionDays,7)
    const legacyA = (await f.legacy('a','legacy-a','literal emerald search result A'))!
    const legacyB = (await f.legacy('b','legacy-b','literal sapphire search result B'))!
    assert(legacyA && legacyB); assert(legacyA.complete && legacyB.complete)
    assert.equal((await f.service.read({sessionId:'a'},{refId:legacyA.id})).text,'literal emerald search result A')
    assert.deepEqual((await f.service.search({sessionId:'a'},{query:'emerald'})).hits.map(hit=>hit.ref.id),[legacyA.id])
    const database = join(f.ownedRoot,'index.sqlite')
    await save(f.root,'sqlite-positive',{database,databasePathLength:database.length,journalPathLength:(database+'-journal').length,legacyA,legacyB,files:await inventory(f.ownedRoot)})
    const complete = await f.task('a','complete',140000)
    const staged = await f.task('a','staged',90000,true)
    const other = await f.task('b','other',80000)
    const managedBefore = await inventory(f.managed)
    const countsBefore = structuredClone([complete.counts,staged.counts,other.counts])
    assert.equal((await f.service.reconcileResult(staged.operation.owner.operationId,staged.operation.id)).kind,'recovery-required')
    await readManaged(f.service,'a',complete.ref,complete.expected); await readManaged(f.service,'b',other.ref,other.expected)
    assert.equal(total(await inventory(f.ownedRoot)) > 65536,true)
    const oldConfig=f.service.status().config
    await assert.rejects(f.service.configure({maxDiskBytes:65536}),/smaller than retained storage/)
    assert.deepEqual(f.service.status().config,oldConfig); assert.deepEqual(await inventory(f.managed),managedBefore)
    await f.service.configure({maxDiskBytes:3145728}); await f.service.configure({maxDiskBytes:2097152})
    // A durable owner grant and current source visibility are separate facts.
    await f.service.grant({sessionId:'a'},[legacyA.id],'b')
    const ownerLedger=JSON.parse(await fs.readFile(join(f.ownedRoot,'owners',legacyA.id+'.json'),'utf8'))
    assert.deepEqual(ownerLedger.sort(),['a','b'])
    await assert.rejects(f.service.read({sessionId:'b'},{refId:legacyA.id}),/unavailable or unauthorized/)
    await f.retire(); await f.settingsFor(65536)
    const lower=await f.mount(true,false); assert.equal(lower.maxDiskBytes,65536)
    await assert.rejects(f.runtime.sourceFor('a'),/not currently confirmed/)
    await assert.rejects(readManaged(f.service,'a',complete.ref,complete.expected),/unauthorized/)
    for (const project of f.projects) await f.broker.configure(project)
    await readManaged(f.service,'a',complete.ref,complete.expected)
    const oldIndex=await fs.readFile(database), oldAuthority=await inventory(f.managed), beforeLowerOpen=await inventory(f.ownedRoot)
    await assert.rejects(f.service.search({sessionId:'a'},{query:'emerald'}),/smaller than retained storage/)
    assert.deepEqual(await fs.readFile(database),oldIndex); assert.deepEqual(await inventory(f.ownedRoot),beforeLowerOpen)
    const scope=f.service.registerResultScope({operationId:'lower-new',sessionId:'a',callId:'lower-new',documentId:'a',source:await f.runtime.sourceFor('a')},()=>true)
    await assert.rejects(f.service.beginResult(scope,'text-utf8-v1'),{code:'ARTIFACT_QUOTA'})
    assert.equal((await f.service.reconcileResult(staged.operation.owner.operationId,staged.operation.id)).kind,'recovery-required')
    assert.deepEqual(await inventory(f.managed),oldAuthority)
    await f.service.configure({maxDiskBytes:2097152}) // unopened managed-only branch may accept config while preserving bytes
    assert.equal((await f.service.search({sessionId:'a'},{query:'emerald'})).hits[0]!.ref.id,legacyA.id)
    await f.service.configure({retentionDays:0})
    const expired=(await f.legacy('a','expires','literal expired opal'))!
    assert(expired); const expiredBlob=join(f.ownedRoot,'blobs',expired.id+'.txt')
    assert.equal((await fs.readFile(expiredBlob)).toString(),'literal expired opal')
    await assert.rejects(f.service.read({sessionId:'a'},{refId:expired.id}),/unavailable/)
    assert.deepEqual((await f.service.search({sessionId:'a'},{query:'opal'})).hits,[])
    assert.equal((await fs.readFile(expiredBlob)).toString(),'literal expired opal')
    await f.service.configure({retentionDays:7})
    await f.coordinator.updateMeta('a',{archived:true}); await assert.rejects(readManaged(f.service,'a',complete.ref,complete.expected),/unauthorized/)
    assert(await f.legacy('b','prune','literal active amethyst'))
    await assert.rejects(fs.stat(expiredBlob),{code:'ENOENT'})
    // Current archive/project denial composes with actual successful legacy cleanup.
    await f.broker.revoke('project-a'); await f.service.configure({maxDiskBytes:2621440})
    await f.service.clear('a')
    assert.equal((await f.service.read({sessionId:'b'},{refId:legacyB.id})).text,'literal sapphire search result B')
    assert.deepEqual(await inventory(f.managed),managedBefore)
    await f.coordinator.updateMeta('a',{archived:false})
    await assert.rejects(readManaged(f.service,'a',complete.ref,complete.expected),/unauthorized/)
    await f.broker.configure(f.projects[0]); await readManaged(f.service,'a',complete.ref,complete.expected)
    // Scoped clear removed a's owner, retaining the granted ledger for b; native policy still denies b.
    assert.deepEqual(JSON.parse(await fs.readFile(join(f.ownedRoot,'owners',legacyA.id+'.json'),'utf8')),['b'])
    await assert.rejects(f.service.read({sessionId:'b'},{refId:legacyA.id}),/unauthorized/)
    // Genuine b ref remains the original recovery target in both funded index cases.
    for (const mode of ['missing','corrupt'] as const) {
      await f.retire(); await f.settingsFor(2097152)
      if (mode==='missing') await fs.rm(database)
      else await fs.writeFile(database,'literal corrupt derived sqlite index')
      const authoritative=await inventory(f.managed)
      await f.mount(true)
      await f.coordinator.updateMeta('a',{archived:true})
      await assert.rejects(readManaged(f.service,'a',complete.ref,complete.expected),/unauthorized/)
      assert.equal((await f.service.search({sessionId:'b'},{query:'sapphire'})).hits[0]!.ref.id,legacyB.id)
      assert.equal((await f.service.read({sessionId:'b'},{refId:legacyB.id})).text,'literal sapphire search result B')
      assert.deepEqual(await inventory(f.managed),authoritative)
      await assert.rejects(readManaged(f.service,'a',complete.ref,complete.expected),/unauthorized/)
      await f.coordinator.updateMeta('a',{archived:false});await readManaged(f.service,'a',complete.ref,complete.expected)
      await save(f.root,'index-'+mode,{legacyB,recovered:true,files:await inventory(f.ownedRoot),managedUnchanged:true,actualArchiveDenialThroughoutRebuild:true,actualRestorationRead:true})
    }
    const cleared=await f.service.clear(); assert.equal(cleared.protectedResults,3)
    assert.deepEqual((await f.service.search({sessionId:'b'},{query:'sapphire'})).hits,[])
    assert.deepEqual(await inventory(f.managed),managedBefore)
    const manifest=await sessionArtifactManifest(f.sessions,f.root,'a'); assert(manifest.documents.includes('task-a'))
    await f.coordinator.deleteOwnedSession!('a',manifest)
    const deletion=await f.coordinator.deletionReceipt!('a'); assert(deletion)
    assert.deepEqual(deletion.manifest.documents,[...manifest.documents].sort())
    await assert.rejects(fs.stat(join(f.managed,complete.ref.id)),{code:'ENOENT'})
    assert.deepEqual(await fs.readFile(join(f.managed,staged.ref.id,'body')),staged.expected)
    assert.deepEqual(await fs.readdir(join(f.managed,staged.ref.id,'pins')),[])
    assert.equal((await f.service.reconcileResult(staged.operation.owner.operationId,staged.operation.id)).kind,'recovery-required')
    await readManaged(f.service,'b',other.ref,other.expected)
    assert.deepEqual([complete.counts,staged.counts,other.counts],countsBefore)
    await save(f.root,'lifecycle',{manifest,deletion,managedBefore,managedAfter:await inventory(f.managed),countsBefore,countsAfter:[complete.counts,staged.counts,other.counts],physicalBytes:total(await inventory(f.ownedRoot)),lowerConfig:lower,indexBeforeLowerSha256:sha(oldIndex),fundedIndexRecoveries:['missing','corrupt'],scopedClear:true,globalClear:true,expiredFilteredThenPhysicallyPruned:true,actualNativeDeletionListenerAlive:true})
  } finally { await f.close() }
},60000)
