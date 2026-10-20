// Read-only acceptance audit; no product imports, no writes to evidence roots.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
const repo = 'D:/I-harness-main', old = path.resolve(repo, '.tmp/r4as-1021-01'), fix = path.resolve(repo, '.tmp/r4as-fix1-1021'), review = path.resolve(repo, '.tmp/r4as-rv2')
const sha = x => crypto.createHash('sha256').update(x).digest('hex')
const load = p => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
const hash = p => sha(fs.readFileSync(p)), git = (...args) => execFileSync('git', args, { cwd: repo })
const at = (root, p) => path.resolve(root, p)
const norm = p => path.resolve(p.replace(/^\\\\\?\\/, '')).toLowerCase()
const roots = [
  [old, 'evidence-inventory.json', '6965b347e3eb85580c49097c3dc51c414553236f87f5b65aa6a1a7b14fc24705'],
  [fix, 'evidence-inventory.json', 'a1a638494fd7568ecb674f1fa8a15b3d8dfc7eea831806cd1428bc107353027c'],
  [review, 'review-control-inventory.json', '027f582f3881152e861cefb27cffc15e7d3a94c799efe36292debb988b06d8d2'],
]
const sealed = []
for (const [root, name, digest] of roots) {
  const seal = load(at(root, 'evidence-seal.json')), rows = load(at(root, name)), actual = []
  assert.equal(hash(at(root, 'evidence-seal.json')), digest); assert.equal(hash(at(root, name)), seal.inventorySha256)
  let files = 0, links = 0, bytes = 0
  for (const row of rows) {
    const p = at(root, row.path), info = fs.lstatSync(p)
    assert(p.startsWith(root + path.sep))
    if (row.kind === 'link') { assert(info.isSymbolicLink()); assert.equal(norm(fs.readlinkSync(p)), norm(row.target)); links++ }
    else { assert(info.isFile() && !info.isSymbolicLink()); assert.equal(info.size, row.bytes); assert.equal(hash(p), row.sha256); files++; bytes += info.size }
  }
  function walk(dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory() && !e.isSymbolicLink()) walk(p); else actual.push(path.relative(root, p).replaceAll('\\', '/')) } }
  walk(root)
  assert.deepEqual(actual.filter(p => ![name, 'evidence-seal.json'].includes(p)).sort(), rows.map(x => x.path).sort())
  assert.equal(files, seal.files); assert.equal(links, seal.links); if (seal.bytes !== undefined) assert.equal(bytes, seal.bytes)
  sealed.push({ root, files, links, bytes, sealSha256: digest })
}
const fixHandback = load(path.join(repo, '.superpowers/sdd/2026-10-21-context-r4a-structure/task-1-fix1-handback.json'))
assert.equal(git('rev-parse', 'HEAD').toString().trim(), fixHandback.head)
for (const item of fixHandback.hashes) assert.equal(hash(path.join(repo, item.path)), item.sha256, item.path)
const source = load(at(fix, 'source-final.json')), oldSource = load(at(old, 'source-final.json'))
for (const r of source) { assert.equal(fs.statSync(path.join(repo, r.path)).size, r.bytes); assert.equal(hash(path.join(repo, r.path)), r.sha256, r.path) }
const reviewerMap = load(at(review, 'source-map.json')), oldDrift = []
for (const r of oldSource) if (hash(path.join(repo, r.path)) !== r.sha256) {
  oldDrift.push(r.path)
  const archived = reviewerMap.copied.find(x => x.variant === 'candidate' && x.original === r.path)
  assert(archived, r.path); assert.equal(hash(archived.copied), r.sha256)
}
assert.deepEqual(oldDrift.sort(), ['packages/context-output/src/legacy/capture.ts', 'packages/context-output/src/service.ts'])
const changed = git('diff', '--name-only', fixHandback.incrementalBase, fixHandback.head, '--', 'packages', 'apps').toString().trim().split(/\r?\n/)
assert.deepEqual(changed.sort(), [...fixHandback.productDelta, fixHandback.newTest].sort())
let portable = 0
for (const dir of ['context-r4a-structure-proof-20261021', 'context-r4a-structure-fix1-proof-20261021']) {
  for (const item of load(path.join(repo, 'docs/research', dir, 'original-bytes.json')).items) {
    const bytes = Buffer.from(item.base64, 'base64'); assert.equal(bytes.length, item.bytes); assert.equal(sha(bytes), item.sha256)
    assert.deepEqual(bytes, fs.readFileSync(path.resolve(repo, item.source))); portable++
  }
}
const gateAudit = []
for (const root of [old, fix]) {
  const dirs = fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && /^\d\d-/.test(e.name)).map(e => e.name).sort()
  let end = 0
  for (const name of dirs) {
    const r = load(at(root, name + '/receipt.json'))
    assert(Date.parse(r.start) >= end); end = Date.parse(r.end)
    assert.equal(r.sourceUnchanged, true)
    assert.equal(hash(at(root, name + '/source-before.json')), hash(at(root, name + '/source-after.json')))
    gateAudit.push({ root, name, exit: r.code, start: r.start, end: r.end })
  }
}
assert.equal(gateAudit.length, 38)
function tests(root, gate, expectedFiles, expectedPass, expectedFail = 0) {
  const r = load(at(root, gate + '/receipt.json')), j = load(at(root, gate + '/tests.json'))
  assert.equal(j.numPassedTests, expectedPass); assert.equal(j.numFailedTests, expectedFail); assert.equal(j.testResults.length, expectedFiles)
  const names = j.testResults.map(x => path.resolve(x.name)).sort(), requested = r.argv.filter(x => /\.test\.[cm]?tsx?$/.test(x)).map(x => path.resolve(repo, x)).sort()
  assert.deepEqual(names, requested); assert.equal(r.code, expectedFail ? 1 : 0)
  return j.testResults.flatMap(x => x.assertionResults.map(a => a.fullName)).sort()
}
tests(old, '16-final-connected', 30, 210)
assert.deepEqual(tests(old, '14-final-fixtures-extracted', 4, 25), tests(old, '15-final-fixtures-base', 4, 25))
tests(fix, '01-red', 1, 1, 2); const baseTests = tests(fix, '02-base', 1, 3)
assert.deepEqual(baseTests, tests(fix, '03-green', 1, 3)); tests(fix, '04-related', 11, 87)
for (const name of ['17-subagent-types-final', '18-context-types-final', '19-executor-types-final', '20-executor-mts-types-final', '21-gateway-types-final']) assert.equal(load(at(old, name + '/receipt.json')).code, 0)
for (const name of fixHandback.types) assert.equal(load(at(fix, name + '/receipt.json')).code, 0)
for (const name of ['23-normal-reachability', '24-normal-reachability-base-entries']) assert.equal(load(at(old, name + '/receipt.json')).code, 1)
for (const ext of ['stdout.txt', 'stderr.txt']) assert.deepEqual(fs.readFileSync(at(old, '23-normal-reachability/' + ext)), fs.readFileSync(at(old, '24-normal-reachability-base-entries/' + ext)))
const oldReplay = load(at(old, 'source-replay.json')), replay = load(at(fix, 'replay.json'))
for (const r of oldReplay.rows) { assert.equal(sha(Buffer.from(r.base, 'base64')), r.baseHash); assert.equal(sha(Buffer.from(r.current, 'base64')), r.currentHash) }
assert.equal(sha(Buffer.from(replay.baseline, 'base64')), replay.baselineHash)
assert.equal(replay.baselineHash, oldReplay.rows.find(x => x.path === replay.path).baseHash)
assert.equal(replay.currentHash, oldReplay.rows.find(x => x.path === replay.path).currentHash)
const testHash = hash(path.join(repo, fixHandback.newTest))
for (const gate of ['01-red', '02-base', '03-green', '04-related']) assert.equal(load(at(fix, gate + '/source-before.json')).find(x => x.path === fixHandback.newTest).sha256, testHash)
const cleanup = load(at(fix, 'cleanup.json')); assert.equal(cleanup.matchingTaskProcesses.length, 0); assert.equal(cleanup.publicTimingObservations.length, 12)
let red = 0, green = 0
for (const row of cleanup.publicTimingObservations) {
  const o = load(row.path); assert.deepEqual(o, row.actual); assert.equal(o.activeJobsAfterClose, 0)
  if (o.mutate === undefined) { assert.equal(o.constructorReads.length, 3); continue }
  assert.equal(o.producerCalls, 1); assert.equal(o.liveText, 'literal original producer body')
  if (row.path.includes('01-red')) { assert.equal(o.beforeReleaseReads.length, 1); if (o.mutate) assert.equal(o.coldError, 'Invalid context artifact identity'); red++ }
  else {
    assert.deepEqual(o.beforeReleaseReads, []); assert.equal(o.reads.length, 3)
    assert.deepEqual(o.reads.map(x => x.legacyDirectoryExists), [false, true, true]); assert(o.reads.every(x => x.phase === 'after-producer-release'))
    assert.equal(o.ref.workspaceId, o.mutate ? 'after' : 'before'); assert.equal(o.coldText, 'literal original producer body'); assert.equal(o.coldError, undefined)
    const bytes = fs.readFileSync(path.join(path.dirname(row.path), 'context-output', sha(o.ref.workspaceId), 'blobs', o.ref.id + '.txt'))
    assert.equal(bytes.toString(), o.coldText); assert.equal(sha(bytes), o.ref.revision); green++
  }
}
assert.equal(red, 2); assert.equal(green, 6)
for (const r of cleanup.finalMixedCleanup) { const c = load(r.path); assert.deepEqual(c, r.actual); assert.equal(c.activeContextJobs, 0); assert.equal(c.activeCodeJobs, 0); assert.equal(c.open, false) }
const report = { status: 'PASS', head: fixHandback.head, sealed, portableOriginals: portable, finalSourceInputs: source.length, originalSourceDrift: oldDrift,
  oldSourceValidatedAgainstImmutableReviewerCopies: true, gates: gateAudit, tests: { original: 210, originalFiles: 30, sameBaseAndExtracted: 25, fixAffected: 87, fixFiles: 11, newRegression: 3, reusedUnaffected: 126, fresh213Claim: false },
  timingControls: { constructor: 4, red, green }, normalReachability: { exit: 1, sameSixFindings: true },
  limitations: ['Original whole-range candidate was rejected; current repair only accepted after review', 'Body-token equality is not argument timing proof', 'No new product runtime in root audit', 'Scale, packaging, whole R4A and counters remain separate'] }
fs.writeFileSync(new URL('./audit.json', import.meta.url), JSON.stringify(report, null, 2), { flag: 'wx' })
console.log(JSON.stringify({ status: 'PASS', roots: sealed.map(x => ({ files: x.files, links: x.links, bytes: x.bytes })), sourceInputs: source.length, portable, gates: gateAudit.length, red, green }))
