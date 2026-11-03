// Read-only root audit. Never imports a product module or writes a sealed root.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
const repo = 'D:/I-harness-main'
const root = path.resolve(repo, '.tmp/r4ai-1021-01')
const sha = x => crypto.createHash('sha256').update(x).digest('hex')
const load = p => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
const hash = p => sha(fs.readFileSync(p))
const git = (...args) => execFileSync('git', args, { cwd: repo })
const norm = p => path.resolve(p.replace(/^\\\\\?\\/, '')).toLowerCase()
const sealPath = path.join(root, 'evidence-seal.json'), seal = load(sealPath)
assert.equal(hash(sealPath), '8ca45474e862626055952c97c32249e87c301c498dfdbfc67b5c8fcedaca85c8')
assert.equal(git('rev-parse', 'HEAD').toString().trim(), seal.head)
for (const item of [seal.inventory, seal.source, seal.report, seal.handback, seal.delivery]) {
  assert.equal(hash(path.isAbsolute(item.path) ? item.path : path.join(root, item.path)), item.sha256)
}
const inventory = load(path.join(root, seal.inventory.path))
assert.equal(inventory.length, seal.inventory.entries)
const seen = new Set(), stats = { files: 0, links: 0, bytes: 0 }
for (const row of inventory) {
  assert(!seen.has(row.path), 'duplicate inventory path'); seen.add(row.path)
  const p = path.resolve(root, row.path)
  assert(p.startsWith(root + path.sep), 'escaped inventory entry')
  const info = fs.lstatSync(p)
  if (row.kind === 'link') {
    assert(info.isSymbolicLink(), row.path)
    assert.equal(norm(fs.readlinkSync(p)), norm(row.target), row.path)
    assert(norm(row.target).startsWith(norm(root) + path.sep), 'foreign fixture target')
    stats.links++
  } else {
    assert(info.isFile() && !info.isSymbolicLink(), row.path)
    assert.equal(info.size, row.bytes, row.path); assert.equal(hash(p), row.sha256, row.path)
    stats.files++; stats.bytes += info.size
  }
}
const actual = []
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory() && !entry.isSymbolicLink()) walk(p)
    else actual.push(path.relative(root, p).replaceAll('\\', '/'))
  }
}
walk(root)
assert.deepEqual(actual.filter(p => !['evidence-seal.json', 'evidence-inventory.json'].includes(p)).sort(), [...seen].sort())
const source = load(path.join(root, seal.source.path))
assert.equal(source.length, seal.source.files)
assert.equal(new Set(source.map(x => x.path)).size, source.length)
for (const row of source) {
  const p = path.join(repo, row.path)
  assert.equal(fs.statSync(p).size, row.bytes, row.path)
  assert.equal(hash(p), row.sha256, row.path)
}
const receipts = fs.readdirSync(root).filter(p => /^\d\d-.+\.receipt\.json$/.test(p)).map(p => load(path.join(root, p)))
const timing = [...receipts].sort((a, b) => Date.parse(a.startedUtc) - Date.parse(b.startedUtc))
for (let i = 1; i < timing.length; i++) assert(Date.parse(timing[i].startedUtc) >= Date.parse(timing[i - 1].finishedUtc), 'overlapping runtime gates')
const gates = []
for (const row of receipts) {
  const before = path.join(root, row.name + '.before.sources.json'), after = path.join(root, row.name + '.after.sources.json')
  const a = load(before), b = load(after), lookup = new Map(b.map(x => [x.path, x.sha256]))
  const delta = a.filter(x => lookup.get(x.path) !== x.sha256).map(x => x.path)
  if (!/^1[24]-/.test(row.name)) assert.equal(hash(before), hash(after), row.name + ' drift')
  else assert.deepEqual([...delta].sort(), ['ownership', 'reader', 'recovery'].map(n => `packages/context-output/src/artifact/${n}.ts`).sort())
  for (const value of Object.values(row.environment)) assert(norm(value).startsWith(norm(root) + path.sep) || norm(value) === norm(root))
  gates.push({ name: row.name, exit: row.nativeExit, sources: a.length, drift: delta })
}
const final = receipts.find(r => r.name === '25-excluded-final-regressions')
assert.equal(final.nativeExit, 0)
assert(final.arguments.includes('--exclude') && final.arguments.includes('**/.tmp/**') && final.arguments.includes('--dir'))
const log = fs.readFileSync(path.join(root, final.name + '.output.txt'), 'utf8')
const collected = [...log.matchAll(/✓\s+(packages\/\S+\.test\.ts)\s+\((\d+) tests?\)/g)].map(m => ({ path: m[1], tests: Number(m[2]) }))
assert.equal(collected.length, 18); assert.equal(collected.reduce((n, x) => n + x.tests, 0), 75)
assert.deepEqual(collected.map(x => x.path).sort(), final.arguments.filter(p => p.endsWith('.test.ts')).sort())
const handback = load(seal.handback.path)
assert.deepEqual(collected.map(x => x.path).sort(), [...handback.finalTests.exactPaths].sort())
for (const name of handback.types) assert.equal(receipts.find(r => r.name === name)?.nativeExit, 0, name)
for (const name of handback.red) assert.equal(receipts.find(r => r.name === name)?.nativeExit, 1, name)
const saveRows = fs.readFileSync(path.join(root, '12-save-base-owners.output.txt'), 'utf8').trim().split(/\r?\n/).map(JSON.parse)
const restores = fs.readFileSync(path.join(root, '14-restore-fixed-owners.output.txt'), 'utf8').trim().split(/\r?\n/).map(JSON.parse)
const redSource = new Map(load(path.join(root, '13-complete-manifest-red.before.sources.json')).map(x => [x.path, x.sha256]))
for (const row of saveRows) {
  assert.equal(sha(git('show', `${seal.base}:${row.file}`)), row.base)
  assert.equal(redSource.get(row.file), row.base)
  assert.equal(hash(path.join(repo, row.file)), row.saved)
  assert.equal(restores.find(x => x.file === row.file).restored, row.saved)
}
const commits = load(path.join(root, 'commit-identity.json'))
assert.deepEqual(git('diff', '--name-only', commits.original, commits.amended).toString().trim().split(/\r?\n/), ['packages/context-output/test/integrity-vectors.ts'])
assert.equal(git('diff', commits.original, commits.amended, '--').toString(), commits.diff)
for (const obj of commits.objects) {
  const p = path.join(root, 'original-commit-objects', obj.id + '.raw'), bytes = fs.readFileSync(p)
  assert.equal(bytes.length, obj.bytes); assert.equal(sha(bytes), obj.sha256)
  assert.equal(crypto.createHash('sha1').update(`${obj.type} ${bytes.length}\0`).update(bytes).digest('hex'), obj.id)
  assert.deepEqual(bytes, git('cat-file', obj.type, obj.id))
}
const output = { status: 'PASS', base: seal.base, head: seal.head, inventory: stats, inventoryEntries: inventory.length,
  sourceFiles: source.length, exactCurrentTestFiles: collected.length, exactTests: 75, nonoverlappingGates: gates,
  rawGitObjects: commits.objects.length, originalAndAmendedCommitDelta: 'one final blank line in constants only; final workspace already qualified',
  explicitLimits: ['No retrospective inventory of accidental historical OS temp dirs', 'No production runtime execution in root audit', 'No scale/package or full R4A acceptance'] }
fs.writeFileSync(new URL('./identity.json', import.meta.url), JSON.stringify(output, null, 2), { flag: 'wx' })
console.log(JSON.stringify({ status: output.status, inventory: stats, sources: source.length, gates: gates.length, tests: output.exactTests }))
