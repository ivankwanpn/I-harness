import { createHash } from 'node:crypto'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, dirname, sep } from 'node:path'
import { gunzipSync } from 'node:zlib'

export const predecessorFixture = new URL('../fixtures/format12-predecessor/', import.meta.url)
export const pinnedSource = 'c76a56011e16057030c2fa7106d358b1eac99657'
const packages = ['@i-harness/core-session','@i-harness/fs-lock','@i-harness/fs-watch','@i-harness/harness-home','@i-harness/session-persistence','@i-harness/session-persistence-jsonl','@i-harness/settings','@i-harness/telemetry','chokidar','readdirp']
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
interface File { path: string; bytes: number; sha256: string }
interface Manifest { version: number; product: string; format: number; packages: string[]; graphFileCount: number; fileCount: number; compressedBytes: number; decodedBytes: number; totalFileBytes: number; capsuleSha256: string; files: File[] }

/** Fixture-only extractor: bounded data capsule, never archive instructions or
 * links. Validate every path/hash before the first extracted file is written. */
export async function extractFormat12Predecessor(target: string, fixture = predecessorFixture) {
  const manifest = JSON.parse(await readFile(new URL('manifest.json', fixture),'utf8')) as Manifest
  const capsule = await readFile(new URL('graph.json.gz', fixture))
  if (manifest.version !== 1 || manifest.product !== pinnedSource || manifest.format !== 12 || JSON.stringify(manifest.packages) !== JSON.stringify(packages)
    || manifest.capsuleSha256 !== 'cbd9444ef627581dccc219c0a81fb489d0ceb5cf17fa11687052d2d3057a46f9'
    || manifest.graphFileCount !== 207 || manifest.fileCount !== 208 || manifest.files.length !== 208
    || !Number.isSafeInteger(manifest.decodedBytes) || manifest.decodedBytes < 1 || manifest.decodedBytes > 8 * 1024 * 1024
    || capsule.length > 2 * 1024 * 1024 || capsule.length !== manifest.compressedBytes || hash(capsule) !== manifest.capsuleSha256) throw Error('Invalid predecessor capsule manifest/hash')
  const decoded = gunzipSync(capsule,{maxOutputLength:8 * 1024 * 1024})
  if (decoded.length !== manifest.decodedBytes) throw Error('Invalid predecessor decoded size')
  const content = JSON.parse(decoded.toString('utf8')) as {version:number;files:{path:string;base64:string}[]}
  if (content.version !== 1 || !Array.isArray(content.files) || content.files.length !== manifest.fileCount) throw Error('Invalid predecessor file count')
  const paths = new Set<string>(), declared = new Map<string,File>(), pending: {path:string;bytes:Buffer}[] = []
  for (const file of manifest.files) {
    if (declared.has(file.path)) throw Error('Duplicate predecessor manifest path')
    declared.set(file.path,file)
  }
  let total = 0, graphFiles = 0
  for (const file of content.files) {
    if (typeof file.path !== 'string' || !/^(?:LICENSE|node_modules\/(?:@i-harness\/[a-z-]+|chokidar|readdirp)\/[A-Za-z0-9_./-]+)$/.test(file.path)
      || file.path.split('/').some(part => part === '.' || part === '..' || !part) || paths.has(file.path.toLowerCase())
      || file.path !== 'LICENSE' && !packages.some(name => file.path.startsWith('node_modules/' + name + '/'))) throw Error('Unsafe or duplicate predecessor path')
    paths.add(file.path.toLowerCase())
    const path = resolve(target,file.path)
    if (!path.startsWith(resolve(target) + sep)) throw Error('Predecessor extraction escaped root')
    const expected = declared.get(file.path)
    if (!expected || !Number.isSafeInteger(expected.bytes) || expected.bytes < 0 || expected.bytes > 1024 * 1024
      || typeof file.base64 !== 'string' || file.base64.length > 2 * 1024 * 1024) throw Error('Invalid predecessor entry bounds')
    const bytes = Buffer.from(file.base64,'base64')
    if (bytes.toString('base64') !== file.base64 || bytes.length !== expected.bytes || hash(bytes) !== expected.sha256) throw Error('Predecessor file hash mismatch')
    total += bytes.length
    if (total > 6 * 1024 * 1024) throw Error('Predecessor total size exceeded')
    if (file.path.startsWith('node_modules/')) graphFiles++
    pending.push({path,bytes})
  }
  if (total !== manifest.totalFileBytes || graphFiles !== 207) throw Error('Predecessor graph total mismatch')
  for (const name of packages) if (!declared.has('node_modules/' + name + '/package.json')) throw Error('Predecessor package missing')
  await mkdir(target,{recursive:false})
  for (const file of pending) { await mkdir(dirname(file.path),{recursive:true}); await writeFile(file.path,file.bytes,{flag:'wx'}) }
  return {product:pinnedSource,graphFiles,fileCount:pending.length,capsuleSha256:manifest.capsuleSha256,packages}
}
