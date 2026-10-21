import assert from 'node:assert/strict'
import { readFileSync, readdirSync, lstatSync, realpathSync, writeFileSync } from 'node:fs'
import { resolve, relative, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'

// Root-owned independent filesystem/receipt audit only. No product/helper imports or test reruns.
const workspace = realpathSync('D:/I-harness-main'), root = resolve(workspace,'.tmp/r4cf-1021-01')
const hash = b => createHash('sha256').update(b).digest('hex')
const raw = p => readFileSync(resolve(root,p)), json = p => JSON.parse(raw(p))
const inside = (base,p) => { const r = relative(base,p); assert(r && !r.startsWith('..') && !isAbsolute(r),p) }
const normalized = p => p.replaceAll('\\','/').toLowerCase()
const unique = a => new Set(a.map(normalized)).size
const seal = json('evidence-seal.json'), inventory = json('evidence-inventory.json'), sources = json('source-final.json'), ledger = json('gate-index.json')
assert.equal(hash(raw('evidence-inventory.json')),seal.inventorySha256)
assert.equal(hash(raw('source-final.json')),seal.sourceManifestSha256)
assert.equal(hash(raw('gate-index.json')),seal.gateIndexSha256)
const paths = []
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = resolve(dir,name), st = lstatSync(p), rel = relative(root,p).replaceAll('\\','/')
    assert(!st.isSymbolicLink(),'Unexpected evidence link '+rel)
    if (st.isDirectory()) walk(p)
    else if (!['evidence-inventory.json','evidence-seal.json'].includes(rel)) paths.push(rel)
  }
}
walk(root)
assert.deepEqual(paths.sort(),inventory.files.map(f=>f.path).sort())
let bytes = 0
for (const f of inventory.files) {
  const p=resolve(root,f.path); inside(root,p)
  assert.equal(f.link,undefined)
  const b=readFileSync(p); assert.equal(b.length,f.bytes,f.path); assert.equal(hash(b),f.sha256,f.path); bytes+=b.length
}
assert.equal(paths.length,seal.files); assert.equal(bytes,seal.bytes); assert.equal(seal.links,0)
for (const f of sources.files) {
  const p=resolve(workspace,f.path); inside(workspace,p)
  const b=readFileSync(p); assert.equal(b.length,f.bytes,f.path); assert.equal(hash(b),f.sha256,f.path)
}
assert.equal(unique(sources.files.map(f=>f.path)),sources.files.length)
const proofPath=resolve(workspace,'docs/research/context-r4a-cold-current-proof-20261021/proof.json')
const proof=JSON.parse(readFileSync(proofPath))
for (const f of proof.records) {
  assert.equal(f.encoding,'gzip-base64'); const b=gunzipSync(Buffer.from(f.data,'base64'))
  const p=resolve(workspace,f.sourcePath); inside(workspace,p)
  assert.equal(b.length,f.bytes,f.sourcePath); assert.equal(hash(b),f.sha256,f.sourcePath); assert.deepEqual(readFileSync(p),b,f.sourcePath)
}
let last=0
for (const r of ledger.gates) {
  assert(Date.parse(r.started)>=last,r.id+' overlap'); last=Date.parse(r.finished)
  inside(root,r.receipt); assert.equal(hash(readFileSync(r.receipt)),r.receiptSha256,r.id)
  assert.deepEqual(JSON.parse(readFileSync(r.receipt)),Object.fromEntries(Object.entries(r).filter(([k])=>!['receipt','receiptSha256'].includes(k))))
  const before=raw(r.id+'/before.json'),after=raw(r.id+'/after.json')
  assert.deepEqual(before,after,r.id+' source drift'); assert.deepEqual(r.changed,[])
  const inputs=Object.keys(JSON.parse(before)); assert.equal(inputs.length,r.inputs); assert.equal(unique(inputs),inputs.length)
  for (const key of ['TEMP','TMP','IH_CONFIG_DIR']) inside(root,r.environment[key])
  assert.equal(r.environment.NODE_PATH,null); assert.equal(r.environment.NODE_OPTIONS,null)
  if(r.executableSha256) assert.equal(hash(readFileSync(r.executable)),r.executableSha256)
  if(r.stdoutSha256) assert.equal(hash(raw(r.id+'/stdout.log')),r.stdoutSha256)
  if(r.stderrSha256) assert.equal(hash(raw(r.id+'/stderr.log')),r.stderrSha256)
}
assert.equal(ledger.gates.length,37)
for(const [name,count,files] of [['23-final-task',82,8],['24-final-catalog',51,5]]) {
  assert.equal(ledger.gates.find(r=>r.id===name).nativeExit,0)
  const out=raw(name+'/stdout.log').toString()
  assert(out.includes(`Tests  ${count} passed (${count})`),name)
  assert(out.includes(`Test Files  ${files} passed (${files})`),name)
}
const copies=json('gateway-source-copy-map.json'); let identical=0,generated=0
for(const f of copies.pairs) {
  inside(resolve(root,'gfinal'),f.candidate)
  const b=readFileSync(f.candidate); assert.equal(b.length,f.bytes); assert.equal(hash(b),f.sha256)
  if(f.sourceIdentical) { assert.deepEqual(readFileSync(f.source),b,f.candidate); identical++ }
  else { assert.equal(f.kind,'builder-generated WSL manifest (verified by actual builder)'); generated++ }
}
assert.equal(copies.pairs.length,8834); assert.equal(unique(copies.pairs.map(f=>f.candidate)),8834); assert.equal(generated,1)
const hosts=[]
for(const label of ['G2','B3']) {
  const r=json(label+'-receipt.json'); assert.equal(r.nativeExit,0); assert.equal(r.candidateStable,true)
  assert.deepEqual(raw(label+'-candidates-before.json'),raw(label+'-candidates-after.json'))
  const observed=json('entry-'+label+'/observations.json')
  assert.equal(observed.rows.length,6); assert(observed.exits.every(e=>e.code===0 && e.signal===null))
  for(const row of observed.rows) {
    const completed=['legacy','migrated','qualified'].includes(row.kind)
    assert.equal(row.parentEnds,row.kind==='qualified'?1:0)
    if(label==='G2') assert.equal(row.catalog.status,completed?'completed':'unavailable')
    else assert.equal(row.explicitOutput.tasks[0].outcome,completed?'completed':'recovery-required')
  }
  assert.equal(observed.requests.length,label==='G2'?0:12)
  if(label==='G2') assert.equal(observed.notifications.length,0)
  const executable=observed.launches[0].args
  if(label==='B3') { assert.equal(executable[0],resolve(root,'bfinal/ih.mjs')); assert.equal(executable[1],'sdk'); assert.equal(observed.launches.length,2) }
  else assert.equal(executable[2],resolve(root,'gfinal/cli/src/cli.ts'))
  hosts.push({label,requests:observed.requests.length,notifications:observed.notifications.length,exits:observed.exits,rows:observed.rows.map(r=>r.kind)})
}
const oldCensus=JSON.parse(readFileSync(resolve(workspace,'.tmp/r4v1/final-closed-audit/product-census.json')))
const freshCensus=json('product-census.json')
const census={old:{raw:oldCensus.rows.length,unique:unique(oldCensus.rows.map(r=>r.file))},fresh:{raw:freshCensus.rows.length,unique:unique(freshCensus.rows.map(r=>r.file))}}
assert.deepEqual(census,{old:{raw:260,unique:222},fresh:{raw:262,unique:223}})
const summary={status:'PASS',scope:'Independent read-only exact evidence/source/portable/receipt/copy/selected consumer and census audit; no product tests rerun, no whole-stage acceptance.',
  productHead:sources.productHead,files:paths.length,bytes,links:0,sourceInputs:sources.files.length,portableOriginals:proof.records.length,
  sealSha256:hash(raw('evidence-seal.json')),proofSha256:hash(readFileSync(proofPath)),gates:ledger.gates.length,
  failedReceiptsPreserved:ledger.gates.filter(r=>r.nativeExit!==0).map(r=>({id:r.id,nativeExit:r.nativeExit})),
  finalTests:[{name:'task',passed:82,files:8},{name:'Gateway focused',passed:51,files:5}],sourceIdenticalCopies:identical,generatedCopies:generated,hosts,census,
  limitations:['Earlier helper variants are hash-only unless separately archived; original receipts retain that limitation.',
    'Host teardown failures12/13 and instrumented pass14 are not reconciled by this audit.',
    'SDK12 requests are explicit input/mount observations; cold read zeros are separate asserted scope.']}
writeFileSync(resolve(import.meta.dirname,'audit.json'),JSON.stringify(summary,null,2)+'\n')
console.log(JSON.stringify(summary,null,2))
