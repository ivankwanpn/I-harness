import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, readdirSync, lstatSync, realpathSync } from 'node:fs'
import { resolve, relative, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'

// Root-owned independent file/receipt/observation audit. Never imports product,
// writer helpers, a test runner or a build; never modifies sealed evidence.
const workspace = realpathSync('D:/I-harness-main'), root = resolve(workspace, '.tmp/r4hc-02')
const hash = b => createHash('sha256').update(b).digest('hex')
const raw = p => readFileSync(resolve(root, p)), json = p => JSON.parse(raw(p))
const normalized = p => p.replaceAll('\\', '/').toLowerCase()
const unique = rows => new Set(rows.map(normalized)).size
const within = (base, p) => { const r = relative(base, p); assert(r && !r.startsWith('..') && !isAbsolute(r), p) }
const verify = (p, record) => { const b = readFileSync(p); assert.equal(b.length, record.bytes, p); assert.equal(hash(b), record.sha256, p); return b }
const seal = json('evidence-seal.json'), inventory = json('evidence-inventory.json'), sources = json('source-final.json'), ledger = json('gate-index.json')
assert.equal(seal.productHead, '678af03dd54659e22dd5f941112c06ec9917e812')
assert.equal(hash(raw('evidence-seal.json')), '80b58ae2e74ec03004ab7233e663f3e634f37bbdd007f1ee365173b8c5a99d2b')
for (const [name, key] of [['evidence-inventory.json', 'inventorySha256'], ['source-final.json', 'sourceManifestSha256'], ['gate-index.json', 'gateIndexSha256']]) assert.equal(hash(raw(name)), seal[key])
const paths = []
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = resolve(dir, name), st = lstatSync(p), rel = relative(root, p).replaceAll('\\', '/')
    assert(!st.isSymbolicLink(), 'Unexpected evidence link ' + rel)
    if (st.isDirectory()) walk(p)
    else if (!['evidence-inventory.json', 'evidence-seal.json'].includes(rel)) paths.push(rel)
  }
}
walk(root)
assert.deepEqual(paths.sort(), inventory.files.map(f => f.path).sort())
assert.equal(unique(paths), paths.length)
let totalBytes = 0
for (const f of inventory.files) { const p = resolve(root, f.path); within(root, p); totalBytes += verify(p, f).length }
assert.equal(paths.length, 14358); assert.equal(totalBytes, 537142279)
assert.equal(paths.length, seal.files); assert.equal(totalBytes, seal.bytes); assert.equal(seal.links, 0)
assert.equal(sources.productHead, seal.productHead)
for (const f of sources.files) { const p = resolve(workspace, f.path); within(workspace, p); verify(p, f) }
assert.equal(sources.files.length, 2784); assert.equal(unique(sources.files.map(f => f.path)), 2784)
const proofPath = resolve(workspace, 'docs/research/context-r4a-received-cancellation-proof-20261021/proof.json')
const proofBytes = readFileSync(proofPath), proof = JSON.parse(proofBytes)
assert.equal(hash(proofBytes), 'a244304d86ab436c784037b85295762d6915947f97c0178fb0a6faa0f6efc779')
assert.equal(proof.records.length, 206)
for (const f of proof.records) {
  assert.equal(f.encoding, 'gzip-base64')
  const b = gunzipSync(Buffer.from(f.data, 'base64')), p = resolve(workspace, f.sourcePath)
  within(workspace, p); assert.equal(b.length, f.bytes, f.sourcePath); assert.equal(hash(b), f.sha256, f.sourcePath); assert.deepEqual(readFileSync(p), b, f.sourcePath)
}
assert.equal(ledger.gates.length, 41)
let lastEnd = 0
for (const gate of ledger.gates) {
  assert(Date.parse(gate.start) >= lastEnd, gate.id + ' overlaps'); lastEnd = Date.parse(gate.end)
  within(root, gate.receipt); assert.equal(hash(readFileSync(gate.receipt)), gate.receiptSha256)
  assert.deepEqual(JSON.parse(readFileSync(gate.receipt)), Object.fromEntries(Object.entries(gate).filter(([k]) => !['receipt', 'receiptSha256'].includes(k))))
  const before = raw(gate.id + '/before.json'), after = raw(gate.id + '/after.json'), rows = JSON.parse(before)
  assert.deepEqual(before, after, gate.id + ' source drift'); assert.equal(gate.sourceStable, true)
  assert.equal(rows.length, gate.sourceInputs); assert.equal(unique(rows.map(r => r.path)), rows.length)
  for (const key of ['TEMP', 'TMP', 'IH_CONFIG_DIR']) within(root, gate.environment[key])
  assert.equal(gate.environment.NODE_PATH, null); assert.equal(gate.environment.NODE_OPTIONS, null)
  assert.equal(hash(readFileSync(gate.executable)), gate.executableSha256)
  assert.equal(hash(raw(gate.id + '/stdout.log')), gate.stdoutSha256)
  assert.equal(hash(raw(gate.id + '/stderr.log')), gate.stderrSha256)
}
const failed = ledger.gates.filter(r => r.nativeExit !== 0).map(r => r.id)
assert.deepEqual(failed, ['01-red-service', '02-red-lifetime', '05-witness-owner', '07-red-default-order', '10-red-closed-boundaries', '12-types-persistence', '16-executor-connected', '21-red-native-origin', '36-public-gateway'])
for (const [id, tests, files] of [['22-final-owner', 36, 5], ['23-ticket-and-final-service', 7, 2], ['19-final-host', 3, 2]]) {
  assert.equal(ledger.gates.find(g => g.id === id).nativeExit, 0)
  const output = raw(id + '/stdout.log').toString()
  assert(output.includes(`Tests  ${tests} passed (${tests})`), id); assert(output.includes(`Test Files  ${files} passed (${files})`), id)
}
const reportedErrors = json('19-final-host/raw-task-errors.json')
assert.deepEqual(reportedErrors.unhandledErrors, []); assert(reportedErrors.rows.every(r => r.state === 'pass'))
const copies = json('gateway-source-copy-map.json'), bundles = json('bundle-source-copy-map.json')
assert.equal(copies.pairs.length, 8835); assert.equal(unique(copies.pairs.map(r => r.candidate)), 8835)
let identical = 0, generated = 0
for (const f of copies.pairs) {
  within(resolve(root, 'g'), f.candidate); const b = verify(f.candidate, f)
  if (f.sourceIdentical) { assert.deepEqual(readFileSync(f.source), b, f.candidate); identical++ }
  else { assert.match(f.kind, /generated WSL manifest/); generated++ }
}
assert.equal(identical, 8834); assert.equal(generated, 1)
assert.equal(bundles.rows.length, 558); assert.equal(unique(bundles.rows.map(r => r.candidate)), 558)
for (const f of bundles.rows) {
  within(resolve(root, 'b'), f.candidate); const b = verify(f.candidate, f)
  if (f.sourceIdentical || f.kind === 'Exact builder-declared module-load asset') assert.deepEqual(readFileSync(f.source), b, f.candidate)
}
assert.equal(hash(raw('b/ih.mjs')), '1a6336970714c9752fb3ad87f9dc6fbea05a7146dd6ffd1f70d010d211b91daa')
const finalSource = new Map(sources.files.map(r => [normalized(r.path), r]))
for (const id of ['27-build-gateway', '28-build-cli']) {
  const before = json(id + '/before.json')
  for (const file of ['managed-document', 'received-input-cancellation', 'received-input-source', 'settlement-fact', 'source-facts']) {
    const path = `packages/session-persistence/src/coordinator/${file}.ts`, row = before.find(r => normalized(r.path) === path)
    assert(row, id + ':' + path); assert.equal(row.sha256, finalSource.get(path).sha256)
  }
}
for (const label of ['CA-before', 'CA-after', 'CB-before', 'CB-after']) {
  const receipt = json(label + '-receipt.json'); assert.equal(receipt.nativeExit, 0); assert.equal(receipt.candidateStable, true)
  assert.deepEqual(raw(label + '-candidate-before.json'), raw(label + '-candidate-after.json'))
  for (const f of json(label + '-candidate-before.json')) { const p = resolve(root, 'g', f.path); within(resolve(root, 'g'), p); verify(p, f) }
  const observed = raw(label + '-stdout.log').toString().trim().split('\n').map(s => JSON.parse(s))[0]
  assert.equal(observed.close, 'fulfilled'); assert.equal(observed.cancellationCaptures, label.endsWith('before') ? 1 : 0)
  if (label.startsWith('CA')) {
    assert.equal(observed.cold, true); assert.equal(observed.requests, 0); assert.equal(observed.promotions, 1)
    assert.equal(observed.cancelled, 0); assert.deepEqual(observed.generationCloses, ['stopped']); assert.equal(observed.run, 'rejected')
  } else {
    assert.equal(observed.parentRound, 3); assert.deepEqual(observed.childRounds, [['root/helper', 3], ['lead/helper-team', 3]])
    assert.equal(observed.notificationGenerationSends, 0); assert.equal(observed.promotionIssues, 1)
  }
  assert(observed.sourceCloses.every(r => r.state === 'fulfilled'))
}
const publicEntries = []
for (const label of ['PG', 'PS']) {
  const receipt = json(label + '-receipt.json'); assert.equal(receipt.nativeExit, 0); assert.equal(receipt.candidateStable, true)
  assert.deepEqual(raw(label + '-candidates-before.json'), raw(label + '-candidates-after.json'))
  const manifest = json(label + '-candidates-before.json')
  for (const [kind, folder] of [['gateway', 'g'], ['bundle', 'b']]) for (const f of manifest[kind]) { const p = resolve(root, folder, f.path); within(resolve(root, folder), p); verify(p, f) }
  const observed = json('entry-' + label + '/observations.json')
  assert.equal(observed.rows.length, 6); assert.equal(observed.requests.length, label === 'PG' ? 0 : 12)
  assert(observed.exits.every(r => r.code === 0 && r.signal === null))
  for (const row of observed.rows) {
    const completed = ['legacy', 'migrated', 'qualified'].includes(row.kind)
    assert.equal(row.parentEnds, row.kind === 'qualified' ? 1 : 0)
    if (label === 'PG') assert.equal(row.catalog.status, completed ? 'completed' : 'unavailable')
    else { assert.deepEqual(row.coldTaskItems, []); assert.equal(row.explicitOutput.tasks[0].outcome, completed ? 'completed' : 'recovery-required') }
  }
  publicEntries.push({ label, requests: observed.requests.length, notifications: observed.notifications.length, exits: observed.exits, rows: observed.rows.map(r => r.kind) })
}
const traces = readdirSync(root).filter(p => /^(CB-|CA-|PG[-.]|PS[-.]|policy-controls[.]).*\.jsonl$/.test(p)).flatMap(file => raw(file).toString().trim().split('\n').filter(Boolean).map(s => ({ file, ...JSON.parse(s) })))
const starts = traces.filter(r => r.family === 'policy-start'), natives = traces.filter(r => r.family === 'native-dlopen'), denials = traces.filter(r => r.kind === 'denied-checkout-or-external')
const runtime = json('runtime-boundaries.json')
assert.deepEqual(starts, runtime.starts); assert.deepEqual(natives, runtime.nativeLoads); assert.deepEqual(denials, runtime.deniedAttempts)
assert.equal(starts.length, 22); assert.equal(natives.length, 11); assert.equal(denials.length, 3)
assert(denials.every(r => r.file.startsWith('policy-controls.')))
for (const start of starts) { assert.equal(start.NODE_PATH, null); for (const p of Object.values(start.effectiveCanonicalPaths)) within(root, p) }
const census = json('product-census.json'), graph = json('production-graph.json'), reuse = json('reuse-comparison.json')
assert.equal(census.rows.length, 227); assert.equal(unique(census.rows.map(r => r.file)), 227)
assert.equal(graph.workspacePackages, 82); assert.equal(graph.cycles, 0); assert.equal(graph.productionImports.length, 1547)
for (const owner of reuse.unchangedOwners) { const p = resolve(workspace, owner.path); assert.equal(hash(readFileSync(p)), owner.sha256) }
assert.deepEqual([reuse.fromCold.unchanged, reuse.fromCold.changed.length, reuse.fromCold.added.length], [8830, 4, 1])
assert.deepEqual([reuse.fromA6.unchanged, reuse.fromA6.changed.length, reuse.fromA6.added.length], [8822, 11, 2])
assert(reuse.large.every(r => r.newlyExecuted === false))
const result = { status: 'PASS', utc: new Date().toISOString(), scope: 'Independent root read-only full sealed-tree/source/proof/receipt/copy/runtime-observation audit; no product/test/build reruns. Native/schema semantics separately source-reviewed.', productHead: seal.productHead,
  sealSha256: hash(raw('evidence-seal.json')), files: paths.length, bytes: totalBytes, links: 0, sourceInputs: sources.files.length, proofRecords: proof.records.length,
  sequentialGates: ledger.gates.length, preservedFailedGates: failed, gatewayCopies: { total: 8835, identical, generated }, bundleRows: bundles.rows.length,
  cliSha256: hash(raw('b/ih.mjs')), publicEntries, policy: { starts: starts.length, nativeLoads: natives.length, deliberateDenials: denials.length }, censusUnique: 227, graph: { workspacePackages: 82, imports: 1547, cycles: 0 },
  limits: ['Gate19 original maintained host precedes final native-origin guard; final-byte controlled copied A/B covers that change.', 'Method-level serial controls are distinct from actual owned journals.', 'Public SDK cold reads are empty/unmounted; explicit user input accounts for12 requests.', 'Historical100MiB/fan qualification reused only under stated changed-owner/branch comparisons; no new whole-history/renderer/installer/provider stress qualification.'] }
writeFileSync(resolve(import.meta.dirname, 'audit.json'), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify({ status: result.status, files: result.files, bytes: result.bytes, sourceInputs: result.sourceInputs, proofRecords: result.proofRecords, gates: result.sequentialGates, copies: result.gatewayCopies, bundleRows: result.bundleRows }))
