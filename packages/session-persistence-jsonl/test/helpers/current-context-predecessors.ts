import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, symlink } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { createRequire } from 'node:module'

const pins = {
  1: { product: '460a2aee9395dafe196eb31425dcc2c3fcdc259e', files: 45, hash: '5a70c62fc2b665350049cfddf7de3feb1963ec283b2e1b860f26c4ab5942a249' },
  11: { product: 'b7ba78b0ae2c977f61709052f4180acae4977fdc', files: 193, hash: '47999e9bbd1e854f7954bb0992339f0e2357dea6f471634ab6eca993a9028af6' },
} as const
const packages = ['@i-harness/core-session', '@i-harness/fs-lock', '@i-harness/fs-watch', '@i-harness/harness-home', '@i-harness/session-persistence', '@i-harness/session-persistence-jsonl', '@i-harness/settings', '@i-harness/telemetry', 'chokidar', 'readdirp']
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/** The real optional OS lock binding is an explicit local test dependency,
 * like the tsx loader. Never rely on pnpm's ambient NODE_PATH for old writes. */
export async function provisionPredecessorLock(target: string) {
  const require = createRequire(new URL('../../../fs-lock/package.json', import.meta.url))
  const entry = require.resolve('koffi'), directory = dirname(entry)
  const metadata = await readFile(resolve(directory, 'package.json'))
  const pkg = JSON.parse(metadata.toString())
  if (pkg.name !== 'koffi' || pkg.version !== '3.1.6') throw Error('Unqualified predecessor lock runtime')
  require('koffi')
  const native = Object.keys(require.cache).find(path => path.endsWith('.node') && path.includes('koffi'))
  if (!native) throw Error('Native predecessor lock binding unavailable')
  const receipt = { version: pkg.version, entry, entrySha256: hash(await readFile(entry)), packageSha256: hash(metadata), native, nativeSha256: hash(await readFile(native)) }
  await symlink(directory, resolve(target, 'node_modules/koffi'), process.platform === 'win32' ? 'junction' : 'dir')
  await writeFile(resolve(target, 'lock-runtime.json'), JSON.stringify(receipt, null, 2))
  return receipt
}
export async function extractCurrentPredecessor(target: string, format: 1 | 11) {
  const pin = pins[format], fixture = new URL('../fixtures/current-context-format' + format + '/', import.meta.url)
  const manifest = JSON.parse(await readFile(new URL('manifest.json', fixture), 'utf8'))
  const capsule = await readFile(new URL('graph.json.gz', fixture))
  if (manifest.product !== pin.product || manifest.format !== format || manifest.version !== 1 || manifest.files.length !== pin.files
    || JSON.stringify(manifest.packages) !== JSON.stringify(packages) || capsule.length > 2 * 1024 * 1024 || hash(capsule) !== pin.hash) throw Error('Invalid pinned predecessor')
  const decoded = gunzipSync(capsule, { maxOutputLength: 8 * 1024 * 1024 })
  if (decoded.length !== manifest.decodedBytes) throw Error('Invalid predecessor size')
  const content = JSON.parse(decoded.toString()), seen = new Set<string>(), pending: { path: string; bytes: Buffer }[] = []
  if (content.version !== 1 || content.files.length !== pin.files) throw Error('Invalid predecessor graph')
  for (const file of content.files) {
    if (typeof file.path !== 'string' || !/^(?:LICENSE|node_modules\/(?:@i-harness\/[a-z-]+|chokidar|readdirp)\/[A-Za-z0-9_./-]+)$/.test(file.path)
      || file.path.split('/').some((part: string) => !part || part === '.' || part === '..') || seen.has(file.path.toLowerCase())
      || file.path !== 'LICENSE' && !packages.some(name => file.path.startsWith('node_modules/' + name + '/'))) throw Error('Unsafe predecessor path')
    seen.add(file.path.toLowerCase())
    const path = resolve(target, file.path), declaration = manifest.files.find((row: { path: string }) => row.path === file.path)
    if (!path.startsWith(resolve(target) + sep) || !declaration || typeof file.base64 !== 'string' || file.base64.length > 2 * 1024 * 1024) throw Error('Invalid predecessor entry')
    const bytes = Buffer.from(file.base64, 'base64')
    if (bytes.toString('base64') !== file.base64 || bytes.length !== declaration.bytes || hash(bytes) !== declaration.sha256) throw Error('Predecessor bytes changed')
    pending.push({ path, bytes })
  }
  await mkdir(target, { recursive: false })
  for (const file of pending) { await mkdir(dirname(file.path), { recursive: true }); await writeFile(file.path, file.bytes, { flag: 'wx' }) }
  return { product: pin.product, packages, format, fileCount: pin.files, capsuleSha256: pin.hash }
}
