import { readFile, writeFile } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const proofPath = 'docs/research/context-r4a-cold-current-proof-20261021/proof.json'
const summary = JSON.parse(await readFile('docs/research/context-r4a-cold-current-proof-20261021/summary.json'))
const proofBytes = await readFile(proofPath), proof = JSON.parse(proofBytes)
assert.equal(hash(proofBytes), summary.proofSha256)
const records = []
for (const record of proof.records) {
  assert.equal(record.encoding, 'gzip-base64')
  const bytes = gunzipSync(Buffer.from(record.data, 'base64'))
  assert.equal(bytes.length, record.bytes, record.sourcePath)
  assert.equal(hash(bytes), record.sha256, record.sourcePath)
  assert.equal(hash(await readFile(record.sourcePath)), record.sha256, record.sourcePath)
  records.push({ path: record.sourcePath, bytes: bytes.length, sha256: hash(bytes) })
}
const gate = JSON.parse(await readFile('.tmp/r4cf-1021-01/gate-index.json'))
const receipts = []
let lastEnd
for (const row of gate.gates) {
  assert.ok(!lastEnd || Date.parse(row.started) >= Date.parse(lastEnd), row.id)
  lastEnd = row.finished
  assert.deepEqual(row.changed, [], row.id)
  const bytes = await readFile(row.receipt), receipt = JSON.parse(bytes)
  assert.equal(hash(bytes), row.receiptSha256, row.id)
  if (receipt.stdoutSha256 !== undefined) assert.equal(hash(await readFile('.tmp/r4cf-1021-01/' + row.id + '/stdout.log')), receipt.stdoutSha256, row.id)
  if (receipt.stderrSha256 !== undefined) assert.equal(hash(await readFile('.tmp/r4cf-1021-01/' + row.id + '/stderr.log')), receipt.stderrSha256, row.id)
  receipts.push({ id: row.id, nativeExit: row.nativeExit, receiptHasLogHashes: receipt.stdoutSha256 !== undefined && receipt.stderrSha256 !== undefined })
}
const manifest = JSON.parse(await readFile('.tmp/r4cf-1021-01/source-final.json'))
for (const row of manifest.files) {
  const bytes = await readFile(row.path)
  assert.equal(bytes.length, row.bytes, row.path)
  assert.equal(hash(bytes), row.sha256, row.path)
}
const censusRows = []
for (const path of ['.tmp/r4v1/final-closed-audit/product-census.json', '.tmp/r4cf-1021-01/product-census.json']) {
  const census = JSON.parse(await readFile(path))
  const rows = census.rows
  assert.ok(Array.isArray(rows))
  censusRows.push({ path, raw: rows.length, unique: new Set(rows.map(row => row.file.replaceAll('\\', '/').toLowerCase())).size })
}
const result = { kind: 'Read-only proof/source/log identity audit; no product imports or runtime/test/build', proofSha256: hash(proofBytes), records: records.length, gates: receipts.length, failed: receipts.filter(row => row.nativeExit !== 0), sourceInputs: manifest.files.length, sourceManifestSha256: hash(await readFile('.tmp/r4cf-1021-01/source-final.json')), censusRows }
await writeFile('.superpowers/sdd/2026-10-21-context-r4a-original-range-review/fix-evidence-audit.json', JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))
