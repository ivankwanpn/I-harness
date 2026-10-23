import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { gzipSync, gunzipSync } from 'node:zlib'

// Maintainer-only, offline reconstruction from immutable Git blobs. Tests use
// committed data capsules and never need Git or an installed old workspace.
const products = { 11: 'b7ba78b0ae2c977f61709052f4180acae4977fdc', 1: '460a2aee9395dafe196eb31425dcc2c3fcdc259e' }
const names = ['core-session', 'fs-lock', 'fs-watch', 'harness-home', 'session-persistence', 'session-persistence-jsonl', 'settings', 'telemetry']
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const oldPath = 'packages/session-persistence-jsonl/test/fixtures/format10-predecessor/'
const manifest10 = JSON.parse(await readFile(oldPath + 'manifest.json', 'utf8'))
const compressed10 = await readFile(oldPath + 'graph.json.gz')
if (hash(compressed10) !== manifest10.capsuleSha256) throw Error('External dependency capsule mismatch')
const external = JSON.parse(gunzipSync(compressed10).toString()).files.filter(file => /^node_modules\/(chokidar|readdirp)\//.test(file.path))
for (const file of external) if (hash(Buffer.from(file.base64, 'base64')) !== manifest10.files.find(row => row.path === file.path)?.sha256) throw Error('External file mismatch')
for (const [format, product] of Object.entries(products)) {
  const git = args => execFileSync('git', args, { maxBuffer: 16 * 1024 * 1024 })
  if (git(['rev-parse', product]).toString().trim() !== product) throw Error('Product pin mismatch')
  const selected = git(['ls-tree', '-r', '--name-only', product, ...names.map(name => 'packages/' + name)]).toString().trim().split('\n')
    .filter(path => /^packages\/[^/]+\/(src\/.*\.ts|package.json)$/.test(path))
  const files = selected.map(source => {
    const bytes = git(['show', product + ':' + source]), path = source.replace(/^packages\/([^/]+)\//, 'node_modules/@i-harness/$1/')
    return { path, source, gitBlob: git(['rev-parse', product + ':' + source]).toString().trim(), base64: bytes.toString('base64') }
  })
  files.push({ path: 'LICENSE', source: 'LICENSE', gitBlob: git(['rev-parse', product + ':LICENSE']).toString().trim(), base64: git(['show', product + ':LICENSE']).toString('base64') }, ...external)
  files.sort((a, b) => a.path.localeCompare(b.path, 'en'))
  const decoded = Buffer.from(JSON.stringify({ version: 1, files: files.map(({ path, base64 }) => ({ path, base64 })) })), capsule = gzipSync(decoded, { level: 9 })
  const manifest = { version: 1, product, format: Number(format), packages: [...names.map(name => '@i-harness/' + name), 'chokidar', 'readdirp'],
    capsuleSha256: hash(capsule), decodedBytes: decoded.length, files: files.map(({ base64, ...row }) => ({ ...row, bytes: Buffer.from(base64, 'base64').length, sha256: hash(Buffer.from(base64, 'base64')) })) }
  const destination = 'packages/session-persistence-jsonl/test/fixtures/current-context-format' + format
  await mkdir(destination, { recursive: true })
  await writeFile(destination + '/manifest.json', JSON.stringify(manifest, null, 2) + '\n')
  await writeFile(destination + '/graph.json.gz', capsule)
  console.log(JSON.stringify({ format, product, files: files.length, capsuleSha256: manifest.capsuleSha256 }))
}
