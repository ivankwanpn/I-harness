import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
const repo = 'D:/I-harness-main', root = path.join(repo, '.tmp/r4as-1021-01')
const load = p => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
const sha = b => crypto.createHash('sha256').update(b).digest('hex')
const normal = b => b.toString().replaceAll('\r\n', '\n')
const replay = load(path.join(root, 'source-replay.json'))
const original = new Map(load(path.join(root, '02-baseline-characterization/source-before.json')).map(r => [r.path, r]))
const rows = []
for (const r of replay.rows) {
  const bytes = Buffer.from(r.base, 'base64')
  assert.equal(sha(bytes), r.baseHash)
  assert.equal(original.get(r.path).sha256, r.baseHash)
  assert.equal(normal(bytes), normal(execFileSync('git', ['show', `bad38c2dc8b5663eaaeb2ef283ecd2b8de7b9994:${r.path}`], { cwd: repo })))
  rows.push({ path: r.path, originalGateRawSha256: r.baseHash, matchesOriginalGateBytes: true, gitBaseTextEqualWithOnlyNewlineConvention: true })
}
const unchanged = load(path.join(repo, '.tmp/r4as-fix1-1021/equivalence.json')).unchangedOwners
for (const p of unchanged) assert.equal(normal(fs.readFileSync(path.join(repo, p))), normal(execFileSync('git', ['show', `bad38c2dc8b5663eaaeb2ef283ecd2b8de7b9994:${p}`], { cwd: repo })))
const out = { status: 'PASS', entryReplay: rows, unchangedOwners: unchanged, limitation: 'Entry replay plus unchanged shared closure, not full BASE checkout; raw native input is verified against original gate manifest, Git comparison only normalizes newline convention.' }
fs.writeFileSync(new URL('./base-identity.json', import.meta.url), JSON.stringify(out, null, 2), { flag: 'wx' })
console.log(JSON.stringify({ status: 'PASS', originalEntries: rows.length, unchangedOwners: unchanged.length }))
