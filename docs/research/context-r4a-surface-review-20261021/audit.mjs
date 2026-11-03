import { readFileSync, readdirSync, lstatSync, realpathSync, writeFileSync } from 'node:fs'
import { resolve, relative, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'

// Independent read-only audit of delivered evidence. Never imports product or
// executes a sealed runner. Output belongs only to this root-owned sibling.
const workspace = realpathSync(process.cwd()), root = resolve(workspace, '.tmp/r4au-1021-01')
const hash = b => createHash('sha256').update(b).digest('hex')
const json = name => JSON.parse(readFileSync(resolve(root, name), 'utf8'))
const inside = (parent, child) => { const r = relative(parent, child); assert(r && !r.startsWith('..') && !isAbsolute(r), child) }
const receipts = readdirSync(root).filter(n => /^\d+.*\.receipt\.json$/.test(n)).sort().map(json)
let lastEnd = 0
for (const r of receipts) {
  assert(Date.parse(r.start) >= lastEnd, 'overlapping gate ' + r.name)
  lastEnd = Date.parse(r.end)
  const before = json(r.name + '.before.json'), after = json(r.name + '.after.json')
  assert.equal(hash(JSON.stringify(before)), r.beforeSha256, r.name + ' before')
  assert.equal(hash(JSON.stringify(after)), r.afterSha256, r.name + ' after')
  assert.deepEqual(before, after, r.name + ' source stability')
  assert.equal(r.sourceStable, true)
  assert.equal(hash(readFileSync(resolve(root, r.name + '.stdout.log'))), r.stdoutSha256)
  assert.equal(hash(readFileSync(resolve(root, r.name + '.stderr.log'))), r.stderrSha256)
  const isolation = json(r.name + '.isolation.json')
  assert.equal(isolation.exit, 0); assert.equal(isolation.stderr, '')
  const effective = JSON.parse(isolation.stdout)
  assert.equal(realpathSync(effective.root), realpathSync(root))
  assert.equal(effective.executable, r.executable)
  for (const p of Object.values(effective.paths)) inside(root, p)
  for (const key of ['TEMP', 'TMP', 'IH_CONFIG_DIR']) inside(root, r.environment[key])
  assert.equal(effective.paths.tmp, r.environment.TEMP)
  assert.equal(effective.paths.config, r.environment.IH_CONFIG_DIR)
}
const selections = json('qualification-plan.json').filter(p => Number(p.name.slice(0, 2)) < 23)
selections.push({ name: '39-acp-final', pkg: 'packages/acp', paths: ['test/acp.test.ts'] })
let passed = 0, files = 0
const tested = []
for (const p of selections) {
  const r = receipts.find(r => r.name === p.name); assert.equal(r?.exit, 0, p.name)
  const report = json(p.name + '.tests.json')
  const expected = p.paths.map(f => resolve(workspace, p.pkg, f).replaceAll('\\', '/')).sort()
  const actual = report.testResults.map(f => f.name.replaceAll('\\', '/')).sort()
  assert.deepEqual(actual, expected, p.name + ' exact collection')
  const assertions = report.testResults.flatMap(f => f.assertionResults)
  assert(assertions.every(a => a.status === 'passed'), p.name)
  assert.equal(assertions.length, report.numTotalTests)
  assert.equal(report.numPassedTests, assertions.length)
  assert.equal(report.numFailedTests, 0); assert.equal(report.numPendingTests, 0)
  passed += assertions.length; files += actual.length
  tested.push({ name: p.name, passed: assertions.length, files: actual.length })
}
assert.equal(passed, 601); assert.equal(files, 72)
const original = json('original-source-identities.json')
for (const f of original) assert.equal(hash(readFileSync(resolve(root, 'original', f.path))), f.sha256, f.path)
const delivered = json('source-delivered.json')
let sourceBytes = 0
for (const f of delivered.files) {
  const p = resolve(workspace, f.path); inside(workspace, p)
  if (f.symlink) { assert(lstatSync(p).isSymbolicLink(), f.path); continue }
  const bytes = readFileSync(p)
  assert.equal(bytes.length, f.bytes, f.path); assert.equal(hash(bytes), f.sha256, f.path)
  sourceBytes += bytes.length
}
const classified = json('final-input-inventory.json')
assert.equal(classified.maintained.length, 2736); assert.equal(classified.sealedExtras.length, 2017)
assert.deepEqual([...classified.maintained, ...classified.sealedExtras].sort((a,b) => a.path.localeCompare(b.path)), [...delivered.files].sort((a,b) => a.path.localeCompare(b.path)))
const oldFreeze = new Map(json('13-final-session.before.json').files.map(f => [f.path, f]))
const newFreeze = new Map(delivered.files.map(f => [f.path, f]))
const drift = [...new Set([...oldFreeze.keys(), ...newFreeze.keys()])].filter(p => JSON.stringify(oldFreeze.get(p)) !== JSON.stringify(newFreeze.get(p))).sort()
assert.deepEqual(drift, [...classified.sourceDriftAfterMainFreeze].sort())
for (const n of ['24-types-core-session','25-types-output-retention','26-types-session-executor','27-types-desktop-gateway','28-types-cli','29-types-executor-mts','40-acp-types-final','41-normal-reachability-final','42-normal-graph-json-final','43-dependency-census-final','44-complete-product-census']) assert.equal(receipts.find(r => r.name === n)?.exit, 0, n)
const seal = json('evidence-seal.json'), inventory = json('evidence-inventory.json')
assert.equal(hash(readFileSync(resolve(root, seal.inventory))), seal.inventorySha256)
assert.equal(hash(readFileSync(resolve(root, seal.source))), seal.sourceSha256)
const actualFiles = []
function walk(path) {
  for (const d of readdirSync(path, { withFileTypes: true })) {
    const p = resolve(path, d.name), rel = relative(root, p).replaceAll('\\', '/')
    assert(!d.isSymbolicLink(), 'Unexpected evidence link ' + rel)
    if (d.isDirectory()) walk(p)
    else if (!seal.exclusions.includes(rel)) actualFiles.push(rel)
  }
}
walk(root)
assert.deepEqual(actualFiles.sort(), inventory.files.map(f => f.path).sort())
let evidenceBytes = 0
for (const f of inventory.files) {
  const p = resolve(root, f.path); inside(root, p)
  const b = readFileSync(p); assert.equal(b.length, f.bytes, f.path); assert.equal(hash(b), f.sha256, f.path); evidenceBytes += b.length
}
assert.equal(inventory.files.length, seal.files); assert.equal(evidenceBytes, seal.bytes); assert.equal(inventory.links.length, 0)
const portable = JSON.parse(readFileSync(resolve(workspace, 'docs/research/context-r4a-surface-proof-20261021/original-bytes.json'), 'utf8'))
for (const f of portable.items) {
  const b = Buffer.from(f.base64, 'base64'); assert.equal(b.length, f.bytes); assert.equal(hash(b), f.sha256)
  const external = f.path.startsWith('.superpowers/sdd/2026-10-21-context-r4a-surface/')
  const parent = external ? workspace : root, originalPath = resolve(parent, f.path)
  inside(parent, originalPath)
  assert.deepEqual(readFileSync(originalPath), b, f.path)
}
const base = '9b9d1193b8d161d93c8650300d61d731d09830b6'
const localDeclarations = ['packages/core-session/src/results/exec-frames.ts','packages/core-session/src/serialization/json-stream.ts','packages/core-session/src/results/validate.ts','packages/output-retention/src/result/capture.ts','packages/output-retention/src/result/exec-frames.ts']
const normalizeDecl = s => s.replaceAll('\r\n','\n').replace(/export (?=(?:interface|function)\b)/g, '')
for (const p of localDeclarations) assert.equal(normalizeDecl(execFileSync('git', ['show', base + ':' + p], {encoding:'utf8'})), normalizeDecl(readFileSync(resolve(workspace,p),'utf8')), p)
const summary = { status: 'PASS', performed: 'read-only hashes/identity/collection checks; no runtime tests rerun', receipts: receipts.length,
  failuresPreserved: receipts.filter(r => r.exit !== 0).map(r => ({ name: r.name, exit: r.exit })), tests: { passed, files, gates: tested },
  originalCopies: original.length, deliveredSource: { count: delivered.files.length, bytes: sourceBytes, exclusions: delivered.exclusions },
  sourceReuse: { exactDeclaredDrift: drift, maintained: classified.maintained.length, sealedExtras: classified.sealedExtras.length },
  evidenceClosure: { files: inventory.files.length, bytes: evidenceBytes, links: 0, inventorySha256: seal.inventorySha256, sealSha256: hash(readFileSync(resolve(root, 'evidence-seal.json'))) },
  portableOriginals: portable.items.length, definingAlgorithmsUnchangedExceptExport: localDeclarations,
  lastGateEnd: receipts.at(-1)?.end }
writeFileSync(resolve(import.meta.dirname, 'audit.json'), JSON.stringify(summary, null, 2) + '\n')
console.log(JSON.stringify(summary, null, 2))
