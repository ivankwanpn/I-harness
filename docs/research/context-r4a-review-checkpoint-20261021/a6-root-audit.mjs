import assert from 'node:assert/strict'
import { readFileSync, readdirSync, lstatSync, realpathSync, writeFileSync } from 'node:fs'
import { resolve, relative, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'

// Root-owned READ-ONLY evidence audit. No product or sealed helper imports.
const workspace = realpathSync(process.cwd()), root = resolve(workspace, '.tmp/r4v1')
const hash = b => createHash('sha256').update(b).digest('hex')
const raw = p => readFileSync(resolve(root, p))
const json = p => JSON.parse(raw(p))
const inside = (base, path) => { const r = relative(base, path); assert(r && !r.startsWith('..') && !isAbsolute(r), path) }
const seal = json('evidence-seal.json'), inventory = json('evidence-inventory.json')
assert.equal(hash(raw('evidence-inventory.json')), seal.inventorySha256)
assert.equal(hash(raw('final-input-inventory.json')), seal.finalInputSha256)
assert.equal(hash(raw('portable/original-bytes.json')), seal.portableSha256)
const actual = []
function walk(path) {
  for (const name of readdirSync(path)) {
    const p = resolve(path, name), stat = lstatSync(p), rel = relative(root, p).replaceAll('\\', '/')
    assert(!stat.isSymbolicLink(), 'Unexpected evidence link: ' + rel)
    if (stat.isDirectory()) walk(p)
    else if (!['evidence-inventory.json','evidence-seal.json'].includes(rel)) actual.push(rel)
  }
}
walk(root)
assert.equal(inventory.links.length, 0)
assert.deepEqual(actual.sort(), inventory.files.map(f => f.path).sort())
let total = 0
for (const f of inventory.files) {
  const p = resolve(root, f.path); inside(root, p)
  const b = readFileSync(p); assert.equal(b.length, f.bytes, f.path); assert.equal(hash(b), f.sha256, f.path); total += b.length
}
assert.equal(inventory.files.length, seal.regularFiles); assert.equal(total, seal.regularBytes)
const source = json('final-input-inventory.json')
for (const f of source.files) {
  const p = resolve(workspace, f.path); inside(workspace, p)
  const b = readFileSync(p); assert.equal(b.length, f.bytes, f.path); assert.equal(hash(b), f.sha256, f.path)
}
const portable = json('portable/original-bytes.json')
for (const f of portable.originals) {
  inside(workspace, f.path)
  const b = Buffer.from(f.base64, 'base64')
  assert.equal(b.length, f.bytes, f.path); assert.equal(hash(b), f.sha256, f.path)
  assert.deepEqual(readFileSync(f.path), b, f.path)
}
assert.equal(portable.originals.length, seal.portableOriginals)
const receipts = readdirSync(root).filter(n => /^\d\d-.*\.receipt\.json$/.test(n)).sort().map(json)
let last = 0
for (const r of receipts) {
  assert(Date.parse(r.start) >= last, r.name + ' overlap'); last = Date.parse(r.end)
  const before = raw(r.name + '.before.json'), after = raw(r.name + '.after.json')
  assert.equal(hash(before), r.beforeSha256, r.name); assert.equal(hash(after), r.afterSha256, r.name)
  assert.deepEqual(before, after, r.name + ' source drift'); assert.equal(r.sourceStable, true)
  assert.equal(hash(raw(r.name + '.stdout.log')), r.stdoutSha256, r.name)
  assert.equal(hash(raw(r.name + '.stderr.log')), r.stderrSha256, r.name)
  assert.equal(hash(readFileSync(r.executable)), r.executableSha256, r.name)
  const probe = json(r.name + '.isolation.json'); assert.equal(probe.exit, 0); assert.equal(probe.stderr, '')
  const effective = JSON.parse(probe.stdout)
  assert.equal(effective.executable, r.executable); assert.equal(realpathSync(effective.root), root)
  for (const p of Object.values(effective.paths)) inside(root, p)
  assert.equal(effective.env.NODE_PATH, null); assert.equal(effective.env.NODE_OPTIONS, null)
  assert.equal(effective.env.TEMP, r.environment.TEMP); assert.equal(effective.env.TMP, r.environment.TMP)
  assert.equal(effective.env.IH_CONFIG_DIR, r.environment.IH_CONFIG_DIR)
}
assert.equal(receipts.length, 48)
const tests = []
for (const name of ['01-p3-native','20-current-executor','34-cli-final-focused','40-bundle-consent-controls','41-final-bundle-witness','42-guards-role','43-headless-routing']) {
  const r = receipts.find(r => r.name === name); assert.equal(r?.exit, 0, name)
  const report = json(name + '.tests.json'), assertions = report.testResults.flatMap(f => f.assertionResults)
  assert(assertions.every(a => a.status === 'passed'), name)
  assert.equal(assertions.length, report.numPassedTests); assert.equal(report.numFailedTests, 0); assert.equal(report.numPendingTests, 0)
  tests.push({ name, passed: assertions.length, paths: report.testResults.map(f => f.name) })
}
const copies = json('final-closed-audit/gateway-source-copy-map.json')
let identical = 0, generated = 0
for (const pair of copies.pairs) {
  inside(resolve(root, 'g'), pair.candidate)
  const b = readFileSync(pair.candidate); assert.equal(b.length, pair.bytes); assert.equal(hash(b), pair.sha256)
  if (pair.sourceIdentical) { assert.deepEqual(readFileSync(pair.source), b, pair.candidate); identical++ }
  else { assert.equal(pair.kind, 'builder-generated WSL manifest (verified by actual builder)'); generated++ }
}
assert.equal(identical, 8832); assert.equal(generated, 1)
const passed = prefix => raw(prefix + '.native-stdout.log').toString().trim().split('\n').map(line => JSON.parse(line)).find(row => row.kind === 'passed')
const ordinary = passed('normal100'), native = passed('exec100'), fan = passed('fan100')
assert(ordinary && native && fan)
assert.equal(ordinary.originalBytes, 104857600); assert.equal(ordinary.encodedBytes, 104857602)
assert.equal(ordinary.bodies, 1); assert.equal(ordinary.hooks, 1); assert(ordinary.modelBytes <= 64000)
assert.equal(native.originalBytes, 104857600); assert.equal(native.records, 3840)
assert.equal(native.rawPageIo.bodyIo, 65536); assert.equal(native.crossingPageIo.bodyIo, 131072)
assert.equal(native.launches, 1); assert.equal(native.releases, 1); assert.equal(native.bodies, 1); assert.equal(native.hooks, 1); assert.equal(native.cancels, 0)
const summary = { status: 'PASS', scope: 'independent read-only identity/closure/receipt/selected native oracle checks; not product test reruns or whole-stage acceptance',
  files: inventory.files.length, bytes: total, links: 0, finalInputs: source.files.length, portableOriginals: portable.originals.length,
  sealSha256: hash(raw('evidence-seal.json')), receipts: receipts.length, failedReceiptsPreserved: receipts.filter(r => r.exit !== 0).map(r => ({name:r.name,exit:r.exit})),
  tests, sourceIdenticalGatewayCopies: identical, generatedGatewayCopies: generated,
  ordinary: { originalBytes:ordinary.originalBytes, encodedBytes:ordinary.encodedBytes, digest:ordinary.digest, modelBytes:ordinary.modelBytes, pages:ordinary.pages },
  native: { originalBytes:native.originalBytes, encodedBytes:native.encodedBytes, rawDigest:native.rawDigest, encodedDigest:native.encodedDigest, records:native.records, pages:native.pages,
    insideBody:native.rawPageIo.bodyIo,crossingBody:native.crossingPageIo.bodyIo },
  fanKeys: Object.keys(fan) }
writeFileSync(resolve(import.meta.dirname, 'audit.json'), JSON.stringify(summary,null,2)+'\n')
console.log(JSON.stringify({...summary,tests:tests.map(t=>({name:t.name,passed:t.passed,files:t.paths.length}))},null,2))
