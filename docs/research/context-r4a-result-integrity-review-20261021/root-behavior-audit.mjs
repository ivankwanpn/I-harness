// Independent literal/receipt audit; only Node builtins, no product imports.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
const repo = 'D:/I-harness-main', root = path.join(repo, '.tmp/r4ai-1021-01')
const digest = x => crypto.createHash('sha256').update(x).digest()
const hex = x => digest(x).toString('hex')
const load = p => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
const file = name => path.join(root, name)
const names = fs.readdirSync(root)
const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b }
const makeBody = n => {
  const b = Buffer.alloc(n)
  for (let i = 0; i < n; i++) b[i] = 65 + Math.floor(i / 65536)
  return b
}
const golden = new Map()
for (const n of [0, 65536, 65537, 131073]) {
  const body = makeBody(n), leaves = Math.max(1, Math.ceil(n / 65536)), padded = 2 ** Math.ceil(Math.log2(leaves))
  const heap = new Array(2 * padded)
  for (let i = 0; i < padded; i++) {
    const chunk = body.subarray(i * 65536, (i + 1) * 65536)
    heap[padded + i] = digest(i < leaves
      ? Buffer.concat([Buffer.from([0]), u64(i), u64(chunk.length), chunk])
      : Buffer.concat([Buffer.from([2]), u64(i)]))
  }
  for (let i = padded - 1; i > 0; i--) heap[i] = digest(Buffer.concat([Buffer.from([1]), heap[2 * i], heap[2 * i + 1]]))
  const header = Buffer.alloc(64)
  header.write('IHARTIDX')
  for (const [offset, val] of [[8, 1], [12, 64], [16, 65536]]) header.writeUInt32BE(val, offset)
  for (const [offset, val] of [[24, n], [32, leaves], [40, padded], [48, 2 * padded - 1]]) header.writeBigUInt64BE(BigInt(val), offset)
  const index = Buffer.concat([header, ...heap.slice(1)])
  const manifest = JSON.stringify({ version: 1, codec: 'text-utf8-v1', encodedBytes: n, contentDigest: hex(body),
    completeness: 'complete', chunkBytes: 65536, leaves, paddedLeaves: padded, treeRoot: heap[1].toString('hex') })
  golden.set(n, { body, index, vector: { size: n, contentDigest: hex(body), treeRoot: heap[1].toString('hex'), header: header.toString('hex'),
    heap: heap.slice(1).map(x => x.toString('hex')), indexBytes: index.length, indexDigest: hex(index), manifest, revision: hex(manifest) } })
}
const constants = load(file('literal-vector-constants.json'))
assert.deepEqual(constants, [...golden.values()].map(x => x.vector))
const text = fs.readFileSync(path.join(repo, 'packages/context-output/test/integrity-vectors.ts'), 'utf8')
assert.deepEqual(JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf('] as const') + 1)), constants)
let vectors = 0, vectorPages = 0
const vectorGroups = names.filter(n => /^vector-vector-\d+-.*\.json$/.test(n))
for (const name of vectorGroups) {
  const r = load(file(name)), g = golden.get(r.vector.size)
  assert.deepEqual(r.vector, g.vector)
  let at = 0
  assert.equal(r.pages.length, r.native.length)
  for (let i = 0; i < r.pages.length; i++) {
    const p = r.pages[i], actual = Buffer.from(p.data.text), native = r.native[i]
    assert.equal(p.data.kind, 'text'); assert.equal(p.offset, at)
    assert.deepEqual(actual, g.body.subarray(at, at + actual.length))
    assert(Buffer.byteLength(JSON.stringify(p)) <= 32768)
    const end = at + Math.min(g.body.length - at, 32771)
    const ordinals = []
    for (let k = Math.floor(at / 65536); k * 65536 < end; k++) ordinals.push(k)
    const bodyReads = native.reads.filter(x => /[\\/]body$/.test(x.path))
    const indexReads = native.reads.filter(x => /[\\/]index$/.test(x.path))
    const expectedBody = ordinals.reduce((sum, k) => sum + Math.min(65536, g.body.length - 65536 * k), 0)
    const depth = Math.log2((g.vector.heap.length + 1) / 2)
    const expectedIndex = g.body.length === 0 ? 128 : 96 + ordinals.length * (32 + 32 * depth)
    assert.equal(bodyReads.reduce((s, x) => s + x.actual, 0), expectedBody)
    assert.equal(indexReads.reduce((s, x) => s + x.actual, 0), expectedIndex)
    assert.deepEqual(bodyReads.map(x => x.offset), ordinals.map(k => k * 65536))
    at += actual.length
    assert.equal(p.eof, i === r.pages.length - 1)
    if (!p.eof) assert.equal(p.nextOffset, at)
    assert.equal(p.ref.revision, g.vector.revision)
    vectorPages++
  }
  assert.equal(at, g.body.length)
  const directory = path.dirname(r.native[0].opens.find(p => /[\\/]body$/.test(p)))
  assert.deepEqual(fs.readFileSync(path.join(directory, 'body')), g.body)
  assert.deepEqual(fs.readFileSync(path.join(directory, 'index')), g.index)
  assert.equal(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'), g.vector.manifest)
  vectors++
}
assert(vectors >= 4)
const ioGroups = names.filter(n => /^native-io-native-io-.*\.json$/.test(n))
for (const name of ioGroups) {
  const rows = load(file(name))
  for (const [i, expectedReadCount] of [[0, 2], [1, 18]]) {
    const r = rows[i], b = r.reads.filter(x => /[\\/]body$/.test(x.path)), ix = r.reads.filter(x => /[\\/]index$/.test(x.path))
    assert.equal(r.short, i === 1); assert.equal(b.length, expectedReadCount)
    assert.equal(b.reduce((s, x) => s + x.actual, 0), 131072)
    assert.equal(ix.reduce((s, x) => s + x.actual, 0), 288)
    assert(r.page.data.text.startsWith('AB'))
  }
  assert(rows[2].prematureEOF.some(x => x.requested > 0 && x.actual === 0))
}
const cold = { redForeign: 0, greenOriginal: 0 }, pin = { redPlaintext: 0, greenDenied: 0 }
for (const name of names.filter(n => /^cold-observations-.*\.json$/.test(n))) {
  const r = load(file(name))
  assert(r.calibratedReads.length > 0)
  const reads = r.reads.filter(x => /[\\/]operation\.json$/.test(x.path))
  assert.equal(r.actual.kind, 'committed')
  if (r.actual.ref.id === r.b.id) { assert.equal(reads.length, 2); cold.redForeign++ }
  else { assert.deepEqual(r.actual.ref, r.a); assert.equal(reads.length, 1); cold.greenOriginal++ }
}
for (const name of names.filter(n => /^pin-pin-controls-.*\.json$/.test(n))) {
  const r = load(file(name)).find(x => x.name === 'pin-operationId')
  assert(r)
  const opened = r.opens.filter(p => /[\\/](body|index)$/.test(p))
  if (r.actual.data?.kind === 'text') {
    assert.equal(r.actual.data.text, 'real original pinned bytes'); assert.equal(opened.length, 2); pin.redPlaintext++
  } else { assert.equal(r.actual.kind, 'unavailable'); assert.equal(opened.length, 0); pin.greenDenied++ }
}
assert(cold.redForeign > 0 && cold.greenOriginal > 0 && pin.redPlaintext > 0 && pin.greenDenied > 0)
let exec = 0, witness = 0
for (const name of names.filter(n => /^exec-exec-controls-.*\.json$/.test(n))) {
  const r = load(file(name))
  assert.deepEqual(r.positive.frames, [{ channel: 'stdout', frame: 0, offset: 0, end: true, data: 'eA==' }])
  const b = r.positiveReads.filter(x => /[\\/]body$/.test(x.path)), ix = r.positiveReads.filter(x => /[\\/]index$/.test(x.path))
  assert.equal(b.length, 3); assert(b.every(x => x.actual === b[0].actual))
  assert.equal(ix.reduce((s, x) => s + x.actual, 0), 384)
  assert.equal(r.malformed.length, 14)
  assert(r.malformed.every(x => x.actual.kind === 'unavailable' && x.actual.reason === 'corrupt'))
  exec++
}
for (const name of names.filter(n => /^witness-witness-integrity-.*\.json$/.test(n))) {
  const r = load(file(name)), policies = r.positive.policies
  assert.equal(policies.length, 4); assert.deepEqual(policies.slice(0, 2), policies.slice(2))
  assert.equal(policies[1].via, policies[0].id); assert.notEqual(policies[1].id, policies[0].id)
  const companions = r.positive.reads.filter(x => /[\\/]pin-memberships[\\/]/.test(x.path))
  assert.equal(companions.length, 2); assert.equal(companions[0].path, companions[1].path)
  assert(r.positive.opens.filter(x => /[\\/](body|index)$/.test(x)).every(x => x.includes(policies[1].id)))
  assert(r.observed.every(x => x.actual.refused === true && !x.opens.some(p => /[\\/](body|index)$/.test(p))))
  witness++
}
const out = { status: 'PASS', independentRecipes: [...golden.values()].map(x => ({ size: x.body.length, index: x.index.length, revision: x.vector.revision })),
  auditedSavedRuns: { vectors, vectorPages, nativeBoundary: ioGroups.length, cold, pin, exec, witness },
  limits: ['Audited saved repeated runs are not additional unique tests', 'No product runtime replay in root audit', 'Range proofs do not certify untouched body chunks'] }
fs.writeFileSync(new URL('./behavior.json', import.meta.url), JSON.stringify(out, null, 2), { flag: 'wx' })
console.log(JSON.stringify(out))
