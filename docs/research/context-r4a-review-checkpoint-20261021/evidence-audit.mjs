import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, basename } from 'node:path'
import assert from 'node:assert/strict'
const root = resolve('.superpowers/sdd/2026-10-21-context-r4a-original-range-review')
const archivePath = 'docs/research/context-r4a-a6-proof-20261021/original-bytes.json'
const archiveBytes = await readFile(archivePath), archive = JSON.parse(archiveBytes)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const verified = [], selected = {}
for (const original of archive.originals) {
  const bytes = Buffer.from(original.base64, 'base64')
  assert.equal(bytes.length, original.bytes)
  assert.equal(hash(bytes), original.sha256)
  assert.equal(hash(await readFile(original.path)), original.sha256)
  verified.push({ path: original.path, bytes: bytes.length, sha256: hash(bytes) })
  if (['native-ledger.json', 'structural-scope-identities.json', 'scale-closure-reuse.json', 'test-collection.json', 'fixed-wire-identities.json', 'fixture-transformations.json', 'identities.json'].includes(basename(original.path))) {
    const value = JSON.parse(bytes)
    selected[basename(original.path)] = { topKeys: Array.isArray(value) ? ['array'] : Object.keys(value), value }
  }
}
const gate = JSON.parse(await readFile('docs/research/context-r4a-a6-proof-20261021/gate-index.json'))
const receipts = []
for (const record of gate.receipts) {
  const path = resolve('.tmp/r4v1', record.file)
  let bytes
  try { bytes = await readFile(path) }
  catch (cause) { throw new Error('Receipt path assumption failed: ' + path, { cause }) }
  assert.equal(hash(bytes), record.receiptSha256)
  receipts.push({ file: record.file, sha256: hash(bytes), exit: record.exit, sourceStable: record.sourceStable })
}
const output = { kind: 'Read-only static identity audit; no product import/runtime or old runner executed', archive: { path: archivePath, sha256: hash(archiveBytes), count: verified.length }, verified, receipts, selected }
await writeFile(resolve(root, 'evidence-audit.json'), JSON.stringify(output, null, 2))
console.log(JSON.stringify({ archive: output.archive, receipts: receipts.length, failedNativeReceipts: receipts.filter(record => record.exit !== 0).length, selected: Object.fromEntries(Object.entries(selected).map(([name, record]) => [name, record.topKeys])) }, null, 2))
