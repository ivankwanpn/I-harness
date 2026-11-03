import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Independent read-only oracle calculation, not execution of sealed controls/product code.
const root = resolve('D:/I-harness-main/.tmp/r4v1')
const read = p => readFileSync(resolve(root, p), 'utf8')
const rows = p => read(p).trim().split('\n').map(JSON.parse)
const pass = p => { const a = rows(p).filter(r => r.kind === 'passed'); assert.equal(a.length, 1); return a[0] }
const inventory = JSON.parse(read('evidence-inventory.json')).files
const byDigest = new Map()
for (const f of inventory) {
  if (!byDigest.has(f.sha256)) byDigest.set(f.sha256, [])
  byDigest.get(f.sha256).push(f)
}
const bodyFor = (digest, bytes) => {
  const matches = (byDigest.get(digest) ?? []).filter(f => f.path.endsWith('/body') && f.bytes === bytes)
  assert.equal(matches.length, 1, `Unique preserved artifact for ${digest}`)
  return matches[0].path
}
const repeatHash = (prefix, count, byte, suffix) => {
  const h = createHash('sha256').update(prefix), block = Buffer.alloc(16384, byte)
  while (count > 0) { const n = Math.min(count, block.length); h.update(block.subarray(0,n)); count -= n }
  return h.update(suffix).digest('hex')
}
const ordinary = pass('normal100.native-stdout.log')
const ordinaryDigest = repeatHash('"', 100 * 1024 * 1024, 120, '"')
assert.equal(ordinary.digest, ordinaryDigest)
assert.equal(ordinary.encodedBytes, 104857602)
const ordinaryBody = bodyFor(ordinaryDigest, 104857602)

const raw = createHash('sha256'), encoded = createHash('sha256').update('IHEXEC01\n')
let encodedBytes = 9, records = 0
for (let frame = 0; frame < 2560; frame++) {
  const channel = frame % 2 ? 'stderr' : 'stdout'
  const data = Buffer.alloc(frame % 2 ? 16384 : 65536, frame % 2 ? 98 : 97)
  raw.update(data)
  for (let offset = 0; offset < data.length; offset += 32768) {
    const piece = data.subarray(offset, offset + 32768)
    const record = JSON.stringify({channel, frame, offset, end: offset + piece.length === data.length, data: piece.toString('base64')}) + '\n'
    encodedBytes += Buffer.byteLength(record); encoded.update(record); records++
  }
}
const native = pass('exec100.native-stdout.log'), rawDigest = raw.digest('hex'), encodedDigest = encoded.digest('hex')
assert.equal(rawDigest, native.rawDigest); assert.equal(encodedDigest, native.encodedDigest)
assert.equal(encodedBytes, native.encodedBytes); assert.equal(records, 3840)
const nativeBody = bodyFor(encodedDigest, encodedBytes)
assert.deepEqual([native.launches,native.releases,native.bodies,native.hooks,native.cancels], [1,1,1,1,0])
assert.equal(native.rawPageIo.bodyIo, 65536); assert.equal(native.crossingPageIo.bodyIo, 131072)
assert.equal(native.rawPageIo.indexIo, 512); assert.equal(native.crossingPageIo.indexIo, 928)
assert(native.rawPageIo.metadataIo <= 8192); assert(native.crossingPageIo.metadataIo <= 8192)

const fan = pass('fan100.native-stdout.log'), childBodies = []
for (let ordinal = 1; ordinal <= 100; ordinal++) {
  const prefix = String(ordinal).padStart(3, '0') + ':'
  const digest = repeatHash('{"resultText":"' + prefix, 1048576 - prefix.length, 120, '"}')
  childBodies.push({ordinal, digest, body: bodyFor(digest, 1048593)})
}
assert.equal(new Set(childBodies.map(f => f.body)).size, 100)
assert.deepEqual([fan.children,fan.distinctRefs,fan.distinctResultRevisions,fan.originalF1Facts,fan.childProviderRequests,fan.outboxWakeRecords], [100,100,100,100,100,100])
assert.equal(fan.sourceBytes,104857600); assert.equal(fan.encodedBytes,104859300)
assert.deepEqual(fan.readOnlyWorkIncrements,{child:0,parent:0})
assert(fan.captureMs < 180000); assert(fan.maxReport <= 16384); assert(fan.maxBodyPage <= 16384)
assert.equal(fan.quotaMetadataIo.pending,0); assert(fan.quotaMetadataIo.peak <= 32)
assert(fan.stateBytes < 819200); assert(fan.taskDocumentBytes < 819200)

const hosts = []
for (const name of ['gatewaysealed','clisealed']) {
  const all = rows(name + '.native-stdout.log'), phase = key => {
    const found = all.filter(r => r.phase === key); assert.equal(found.length,1,key); return found[0]
  }
  assert.equal(phase('background-before-EOF').gateAbsent,true)
  const cold = phase('cold-external-no-work')
  assert.equal(cold.requestIncrement,0); assert.equal(cold.notificationIncrement,0)
  assert.equal(cold.sessionBytesUnchanged,true); assert.equal(cold.foreignDenied,true); assert.equal(cold.staleRefDenied,true)
  assert.equal(phase('explicit-new-input').providerIncrement,1)
  const code = phase('actual-code'); assert.equal(code.acceptedOutputFacts,1); assert.equal(code.encodedBytes,70027)
  const child = phase(name === 'gatewaysealed' ? 'gateway-child-route' : 'cli-active-child-selector')
  assert.equal(child.encodedBytes,70031); assert.equal(child.pages,5)
  const closes = all.filter(r => r.phase === 'native-close'); assert.equal(closes.length,4)
  assert(closes.every(r => r.code === 0 && r.signal === null))
  assert.equal(phase('final-cleanup-exit').code,0)
  const passed = all.filter(r => r.kind === 'passed'); assert.equal(passed.length,1)
  hosts.push({name, requests:passed[0].requests, coldBaseline:cold.baseline.requests,
    codeBytes:code.encodedBytes, childBytes:child.encodedBytes, childPages:child.pages, nativeCloses:closes.length,
    rows:passed[0].rows})
}

const exactPreview = 'native partial 中文🙂'.repeat(40) + 'native partial 中文'
assert.equal(Buffer.byteLength(exactPreview),1021)
const admitted = Buffer.from('native partial 中文🙂'.repeat(10000)).subarray(0,1024)
assert.deepEqual(admitted.subarray(0,1021),Buffer.from(exactPreview))
assert.deepEqual([...admitted.subarray(1021)],[0xf0,0x9f,0x99])

const summary = {status:'PASS',scope:'Independent literal oracle calculations and preserved native log assertions; no product execution, no test reruns, no whole-session qualification.',
  ordinary:{bytes:ordinary.encodedBytes,digest:ordinaryDigest,body:ordinaryBody},
  native:{rawBytes:104857600,rawDigest,encodedBytes,encodedDigest,records,body:nativeBody},
  fan:{children:100,encodedBytes:fan.encodedBytes,parentProviderRequests:fan.parentProviderRequests,captureMs:fan.captureMs,
    maxBodyPage:fan.maxBodyPage,maxReport:fan.maxReport,readOnlyWorkIncrements:fan.readOnlyWorkIncrements,childBodies},
  hosts,exactNativePreviewBytes:1021,
  limits:['Artifact body identities rely on the separately completed whole-inventory hash audit, not a second data read.',
    'Child identities/publication semantics rely on real control assertions plus source review; digest matches alone grant no authority.',
    'Native and host checks are their preserved controlled scopes, not a live provider, full renderer, all OS handles or 100MiB conversation proof.']}
writeFileSync(resolve(import.meta.dirname,'semantic-audit.json'),JSON.stringify(summary,null,2)+'\n')
console.log(JSON.stringify({...summary,fan:{...summary.fan,childBodies:summary.fan.childBodies.length}},null,2))
