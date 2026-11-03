// Read-only original-byte/source/receipt/literal audit. No product imports.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
const repo = 'D:/I-harness-main', root = path.resolve(repo, '.tmp/r4am-1021-01')
const sha = x => crypto.createHash('sha256').update(x).digest('hex')
const load = p => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
const hash = p => sha(fs.readFileSync(p))
const at = p => path.resolve(root, p), git = (...args) => execFileSync('git', args, { cwd: repo })
const seal = load(at('evidence-seal.json'))
assert.equal(hash(at('evidence-seal.json')), '6e55534b604a583b529c6538780e2f2ae2ff491e2e266247ba0a74f2eff1c55b')
assert.equal(git('rev-parse', 'HEAD').toString().trim(), seal.head)
assert.equal(hash(at('evidence-inventory.json')), seal.inventorySha256)
const inventory = load(at('evidence-inventory.json'))
assert.equal(inventory.length, seal.files); assert.equal(inventory.reduce((n, x) => n + x.bytes, 0), seal.bytes)
for (const row of [...inventory.map(x => ({ ...x, absolute: at(x.path) })), ...seal.external.map(x => ({ ...x, absolute: path.join(repo, x.path) }))]) {
  const s = fs.lstatSync(row.absolute)
  assert(s.isFile() && !s.isSymbolicLink(), row.path)
  assert.equal(s.size, row.bytes, row.path); assert.equal(hash(row.absolute), row.sha256, row.path)
}
const all = []
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    assert(!e.isSymbolicLink(), 'Unexpected evidence link')
    if (e.isDirectory()) walk(p); else all.push(path.relative(root, p).replaceAll('\\', '/'))
  }
}
walk(root)
assert.deepEqual(all.filter(p => !seal.closureExcludes.includes(p)).sort(), inventory.map(x => x.path).sort())
const handback = load(path.join(repo, '.superpowers/sdd/2026-10-21-context-r4a-mixed-retention/handback.json'))
const source = load(at('qualified-source.json'))
assert.equal(source.length, 2671); assert.equal(hash(at('qualified-source.json')), handback.qualifiedSource.sha256)
for (const row of source) {
  assert.equal(fs.statSync(path.join(repo, row.path)).size, row.bytes, row.path)
  assert.equal(hash(path.join(repo, row.path)), row.sha256, row.path)
}
const changed = git('diff', '--name-only', seal.base, seal.head).toString().trim().split(/\r?\n/)
assert.deepEqual([...changed].sort(), [...handback.trackedFiles].sort())
assert(!changed.some(p => /(?:packages|apps)\/[^/]+\/src\//.test(p)), 'Unexpected product delta')
const savedAudit = load(at('final-audit.json'))
for (const row of savedAudit.snapshots) {
  assert.equal(hash(at(row.snapshot)), row.sha256); assert.equal(hash(path.join(repo, row.path)), row.sha256)
}
for (const row of savedAudit.gitObjects) {
  const bytes = git('cat-file', 'commit', row.commit)
  assert.equal(bytes.length, row.bytes); assert.equal(sha(bytes), row.sha256)
  assert.equal(crypto.createHash('sha1').update(`commit ${bytes.length}\0`).update(bytes).digest('hex'), row.commit)
}
const gates = []
for (let i = 1; i <= 17; i++) {
  const id = String(i).padStart(2, '0'), p = `gates/${id}`, r = load(at(p + '/receipt.json'))
  assert.equal(r.code, i === 2 ? 1 : 0); assert.equal(r.signal, null); assert.equal(r.sourceStable, true)
  assert.equal(hash(at(p + '/source-before.json')), hash(at(p + '/source-after.json')))
  assert.equal(hash(at(p + '/source-before.json')), r.beforeSha256)
  assert.equal(load(at(p + '/source-before.json')).length, r.beforeCount)
  if (i >= 14) assert.equal(r.beforeSha256, handback.qualifiedSource.sha256)
  for (const value of Object.values(r.environment)) assert(path.resolve(value).startsWith(root + path.sep))
  if (gates.length) assert(Date.parse(r.started) >= Date.parse(gates.at(-1).ended))
  gates.push({ label: id, started: r.started, ended: r.ended, exit: r.code, sourceCount: r.beforeCount })
}
const test = load(at('gates/14/tests.json'))
assert.equal(test.numTotalTests, 62); assert.equal(test.numPassedTests, 62); assert.equal(test.numFailedTests, 0)
assert.equal(test.testResults.length, 8)
const collected = test.testResults.map(r => ({ path: path.relative(repo, r.name).replaceAll('\\', '/'), tests: r.assertionResults.length, status: r.status }))
assert(collected.every(x => x.status === 'passed')); assert.equal(collected.reduce((n, x) => n + x.tests, 0), 62)
const runtime = load(at('gates/14/receipt.json'))
assert.deepEqual(collected.map(x => x.path).sort(), runtime.args.filter(x => x.endsWith('.test.ts')).sort())
const helperTypes = load(path.join(repo, 'packages/session-executor/tsconfig.mixed-retention.json'))
assert(helperTypes.include.includes('test/helpers/mixed-retention-*.mts'))
for (const row of load(at('guard-check.json'))) {
  assert.equal(row.nativeExit, 0); assert.equal(row.fixtureFilesUnchanged, true)
  assert.equal(row.stdout, 'Mixed retention fixture evidence is sealed\n')
}
const fixtures = at('gates/14/fixtures')
const find = prefix => path.join(fixtures, fs.readdirSync(fixtures).find(n => n.startsWith(prefix + '-')))
const f = { n: find('n'), q: find('q'), c: find('c'), r: find('r'), u: find('u') }
const read = (kind, label) => load(path.join(f[kind], label + '.json'))
const cases = [['n', 'complete', 'a', 140000], ['n', 'staged', 'a', 90000], ['n', 'other', 'b', 80000],
  ['q', 'quota-managed', 'a', 80000], ['q', 'quota-staged', 'a', 70000], ['c', 'calibration', 'a', 70000],
  ['r', 'protected', 'b', 70000], ['u', 'unopened', 'a', 90000]]
const literals = []
for (const [kind, label, owner, length] of cases) {
  const r = read(kind, label), bytes = Buffer.from(JSON.stringify({ resultText: (owner === 'a' ? 'x' : 'y').repeat(length), error: 'literal mixed diagnostic' }))
  assert.equal(r.expected.bytes, bytes.length); assert.equal(r.expected.sha256, sha(bytes))
  assert.equal(r.operation.ref.encodedBytes, bytes.length); assert.equal(r.operation.ref.contentDigest, sha(bytes))
  assert.equal(r.own.body.bytes, bytes.length); assert.equal(r.own.body.sha256, sha(bytes))
  assert.equal(r.operation.owner.documentId, 'task-' + owner)
  assert.deepEqual(r.counts, { captures: 1, sourceBindings: 1, settles: 1, callbacks: 1, resultReads: 1, errorReads: 1 })
  const originalPrefix = path.relative(root, f[kind]).replaceAll('\\', '/') + '/'
  const body = inventory.find(x => x.path.startsWith(originalPrefix) && x.path.endsWith('/' + r.operation.id + '/body'))
  if (body) assert.deepEqual(fs.readFileSync(at(body.path)), bytes)
  else assert(kind === 'n' && label === 'complete', 'Only confirmed-deleted complete a lacks body')
  if (label.includes('staged')) {
    assert.equal(r.operation.phase, 'staged'); assert.equal(r.transitions.length, 1)
    assert.equal(r.transitions[0].nativeRenameSucceeded, true); assert.equal(r.transitions[0].acknowledgement, 'lost')
    assert.equal(r.baseline.formatVersion, 2)
    assert(r.baseline.tasks.some(t => t.id === r.operation.owner.callId && t.status === 'running'))
  } else assert.equal(r.operation.phase, 'committed')
  literals.push({ kind, label, bytes: bytes.length, sha256: sha(bytes), presentBody: !!body })
}
const sequential = read('q', 'sequential-quota')
const prefix = Buffer.from('partial silver ' + 's'.repeat(5000)).subarray(0, 1000)
assert.equal(sequential.partial.bytes, 1000); assert.equal(sequential.partial.originalBytes, 5015); assert.equal(sequential.partial.complete, false)
assert.equal(sequential.partialBodySha256, sha(prefix)); assert.equal(sequential.partial.revision, sha(prefix))
const prefixRow = inventory.find(x => x.path.startsWith(path.relative(root, f.q).replaceAll('\\', '/') + '/') && x.path.endsWith('/blobs/' + sequential.partial.id + '.txt'))
assert(prefixRow); assert.deepEqual(fs.readFileSync(at(prefixRow.path)), prefix)
assert.equal(sequential.none, true); assert.equal(sequential.grantRefused, true); assert.equal(sequential.protectedUnchanged, true)
const schedule = read('r', 'mixed-schedule')
assert.deepEqual([schedule.quota, schedule.initial, schedule.beforeLegacy, schedule.afterLegacy, schedule.afterWrite, schedule.finalBytes],
  [370463, 130463, 130463, 228767, 294339, 228786])
assert.equal(schedule.legacyDisposition, 'none'); assert.equal(schedule.managedSettlement.kind, 'refused'); assert.equal(schedule.managedSettlement.reason, 'quota')
assert.equal(schedule.sampledPeak, 294339); assert.deepEqual(schedule.remainingTemporary, []); assert.equal(schedule.protectedUnchanged, true)
assert(schedule.events.some(x => x.kind === 'managed-native-lstat') && schedule.events.some(x => x.kind === 'legacy-native-stat'))
const cal = read('c', 'native-calibration')
assert.equal(cal.holds, 0); assert.equal(cal.delegatedNativeSuccess, true)
const lifecycle = read('n', 'lifecycle'), lower = read('u', 'unopened-lowering')
assert.deepEqual(lifecycle.countsBefore, lifecycle.countsAfter)
assert.deepEqual(lifecycle.fundedIndexRecoveries, ['missing', 'corrupt'])
assert.equal(lifecycle.lowerConfig.maxDiskBytes, 65536); assert.equal(lifecycle.actualNativeDeletionListenerAlive, true)
assert(lifecycle.deletion.manifest.documents.includes('task-a'))
assert.equal(lower.lowered.config.maxDiskBytes, 65536); assert.equal(lower.occupied, 92105)
assert(lower.legacyNeverOpened && lower.newGrowthRefused)
for (const kind of Object.keys(f)) {
  const cleanup = read(kind, 'cleanup')
  assert.equal(cleanup.open, false); assert.equal(cleanup.activeContextJobs, 0); assert.equal(cleanup.activeCodeJobs, 0)
  assert(cleanup.nativeCloseResolved && cleanup.brokerCloseResolved && cleanup.coordinatorCloseResolved)
}
const result = { status: 'PASS', base: seal.base, head: seal.head, files: seal.files, evidenceBytes: seal.bytes,
  sourceFiles: source.length, nativeGates: gates, productDelta: [], collected, literalRecords: literals,
  partialPrefix: { bytes: prefix.length, sha256: sha(prefix) }, schedule: { quota: schedule.quota, sampledPeak: schedule.sampledPeak, finalBytes: schedule.finalBytes },
  limits: ['One calibrated schedule, not all interleavings or global SQLite peak', 'Deleted complete a audited from preserved original inventory and executed assertions, not recreated body', 'Read-only root audit, not new product runtime tests'] }
fs.writeFileSync(new URL('./audit.json', import.meta.url), JSON.stringify(result, null, 2), { flag: 'wx' })
console.log(JSON.stringify({ status: result.status, sourceFiles: source.length, evidenceFiles: seal.files, gates: gates.length, tests: 62, literalRecords: 9 }))
