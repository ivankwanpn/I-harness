import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import ts from '../../../node_modules/typescript/lib/typescript.js'
const hash = value => createHash('sha256').update(value).digest('hex')
const manifest = JSON.parse(await readFile('.tmp/r4v1/source-final.json'))
let bytes = 0
for (const row of manifest.files) {
  const actual = await readFile(row.path)
  assert.equal(actual.length, row.bytes, row.path)
  assert.equal(hash(actual), row.sha256, row.path)
  bytes += actual.length
}
const archive = JSON.parse(await readFile('docs/research/context-r4a-a6-proof-20261021/original-bytes.json'))
const structural = JSON.parse(Buffer.from(archive.originals.find(row => row.path.endsWith('structural-scope-identities.json')).base64, 'base64'))
const names = ['createOutput', 'createRetirement', 'createSpawnTool', 'createManagedDocument', 'runSdkCommand']
const owners = []
for (const row of structural.ownership) {
  const raw = await readFile(row.path), text = raw.toString('utf8').replace(/\r\n/g, '\n')
  assert.equal(hash(raw), row.physicalSha256)
  const file = ts.createSourceFile(row.path, text, ts.ScriptTarget.Latest, true)
  let found
  const visit = node => { if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) found = node; ts.forEachChild(node, visit) }
  visit(file)
  assert.ok(found, row.path)
  const start = found.getStart(file), end = found.end
  owners.push({ path: row.path, function: found.name.text, lines: file.getLineAndCharacterOfPosition(end).line - file.getLineAndCharacterOfPosition(start).line + 1, characters: end - start, physicalSha256: hash(raw), lfSha256: hash(text), functionLfSha256: hash(text.slice(start, end)) })
}
const prefix = 'native partial 中文🙂'.repeat(40) + 'native partial 中文'
assert.equal(Buffer.byteLength(prefix), 1021)
const result = { kind: 'Read-only source identity/AST and literal calculation, no product import', sourceManifest: { files: manifest.files.length, bytes, sha256: hash(await readFile('.tmp/r4v1/source-final.json')) }, owners, nativePreviewLiteralBytes: Buffer.byteLength(prefix) }
await writeFile(resolve('.superpowers/sdd/2026-10-21-context-r4a-original-range-review/source-audit.json'), JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))
