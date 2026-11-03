import { readFile, writeFile } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const root = '.tmp/r4hc-02', proofPath = 'docs/research/context-r4a-received-cancellation-proof-20261021/proof.json'
const proofBytes = await readFile(proofPath), proof = JSON.parse(proofBytes)
assert.equal(hash(proofBytes), 'a244304d86ab436c784037b85295762d6915947f97c0178fb0a6faa0f6efc779')
for (const record of proof.records) {
  assert.equal(record.encoding, 'gzip-base64')
  const bytes = gunzipSync(Buffer.from(record.data, 'base64'))
  assert.equal(bytes.length, record.bytes, record.sourcePath)
  assert.equal(hash(bytes), record.sha256, record.sourcePath)
  assert.equal(hash(await readFile(record.sourcePath)), record.sha256, record.sourcePath)
}
const gate = JSON.parse(await readFile(root + '/gate-index.json')), receipts = []
let previousEnd
for (const row of gate.gates) {
  assert.ok(!previousEnd || Date.parse(row.start) >= Date.parse(previousEnd), row.id)
  previousEnd = row.end
  const bytes = await readFile(row.receipt), receipt = JSON.parse(bytes)
  assert.equal(hash(bytes), row.receiptSha256, row.id)
  assert.equal(hash(await readFile(root + '/' + row.id + '/stdout.log')), row.stdoutSha256, row.id)
  assert.equal(hash(await readFile(root + '/' + row.id + '/stderr.log')), row.stderrSha256, row.id)
  const before = await readFile(root + '/' + row.id + '/before.json'), after = await readFile(root + '/' + row.id + '/after.json')
  assert.equal(hash(before), hash(after), row.id)
  assert.equal(JSON.parse(before).length, row.sourceInputs, row.id)
  receipts.push({ id: row.id, nativeExit: receipt.nativeExit })
}
const sourceBytes = await readFile(root + '/source-final.json'), source = JSON.parse(sourceBytes)
assert.equal(hash(sourceBytes), 'e2ca48bf72e04736b5bb45eaa2f04225ad14a8d4f4e57f42567129e80f0e2c66')
for (const row of source.files) {
  const bytes = await readFile(row.path)
  assert.equal(bytes.length, row.bytes, row.path); assert.equal(hash(bytes), row.sha256, row.path)
}
const copy = JSON.parse(await readFile(root + '/gateway-source-copy-map.json'))
for (const row of copy.pairs) {
  const bytes = await readFile(row.candidate)
  assert.equal(bytes.length, row.bytes, row.candidate); assert.equal(hash(bytes), row.sha256, row.candidate)
  if (row.sourceIdentical) assert.equal(hash(await readFile(row.source)), row.sha256, row.source)
}
const bundle = JSON.parse(await readFile(root + '/bundle-source-copy-map.json'))
for (const row of bundle.rows) {
  const bytes = await readFile(row.candidate)
  assert.equal(bytes.length, row.bytes, row.candidate); assert.equal(hash(bytes), row.sha256, row.candidate)
  if (row.source && row.sourceIdentical !== false) assert.equal(hash(await readFile(row.source)), row.sha256, row.source)
  if (row.sourceIdentical === false) {
    assert.equal(row.kind, 'Same verified generated WSL manifest')
    const workerHash = hash(await readFile('packages/sandbox-wsl/worker/runner.py'))
    assert.equal(bytes.toString('utf8'), JSON.stringify({ schema: 1, protocol: 1, worker: 'runner.py', sha256: workerHash }) + '\n')
  }
}
const result = { scope: 'Independent read-only portable/source/receipt/copied-candidate identity audit; no product imports/runtime; not full evidence-inventory closure scan', productFreeze: source.productHead, proofRecords: proof.records.length, proofSha256: hash(proofBytes), gateCount: receipts.length, failed: receipts.filter(row => row.nativeExit !== 0), sourceInputs: source.files.length, sourceManifestSha256: hash(sourceBytes), gatewayPairs: copy.pairs.length, sourceIdentical: copy.pairs.filter(row => row.sourceIdentical).length, generated: copy.pairs.filter(row => !row.sourceIdentical).map(row => ({ candidate: row.candidate, sha256: row.sha256 })), bundleFiles: bundle.rows.length, cli: bundle.rows.find(row => row.candidate.endsWith('ih.mjs')) }
await writeFile('.superpowers/sdd/2026-10-21-context-r4a-original-range-review/host-close-final-audit.json', JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))
