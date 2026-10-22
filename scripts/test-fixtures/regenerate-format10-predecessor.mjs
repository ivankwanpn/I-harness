import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { resolve, join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

// Optional maintainer tool. Ordinary tests consume the committed capsule only.
const product = '678af03dd54659e22dd5f941112c06ec9917e812'
const inventorySha256 = '9fe1227241c1400b82b2dcac6bf4d224e55ed06f212e4568752fa663fef494ba'
const mapSha256 = '5a3f719a417e0aa279e4a09941a064cc83df247555848e7975ec4cef55d263b7'
const packages = ['@i-harness/core-session','@i-harness/fs-lock','@i-harness/fs-watch','@i-harness/harness-home','@i-harness/session-persistence','@i-harness/session-persistence-jsonl','@i-harness/settings','@i-harness/telemetry','chokidar','readdirp']
if (!process.argv[2]) throw Error('Usage: node scripts/test-fixtures/regenerate-format10-predecessor.mjs <accepted-evidence-root>')
const source = resolve(process.argv[2]), repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const destination = join(repo,'packages/session-persistence-jsonl/test/fixtures/format10-predecessor')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const inventoryBytes = await readFile(join(source,'evidence-inventory.json'))
const mapBytes = await readFile(join(source,'gateway-source-copy-map.json'))
const seal = JSON.parse(await readFile(join(source,'evidence-seal.json'),'utf8'))
if (seal.productHead !== product || seal.inventorySha256 !== inventorySha256 || hash(inventoryBytes) !== inventorySha256 || hash(mapBytes) !== mapSha256) throw Error('Unrecognized sealed predecessor evidence')
const inventory = new Map(JSON.parse(inventoryBytes).files.map(row => [row.path,row]))
if (inventory.get('gateway-source-copy-map.json')?.sha256 !== mapSha256) throw Error('Source map is not sealed')
const selected = new Map()
for (const row of JSON.parse(mapBytes).pairs) {
  const normalized = row.candidate.replaceAll('\\','/'), marker = '/g/node_modules/', offset = normalized.indexOf(marker)
  if (offset < 0) continue
  const path = normalized.slice(offset + marker.length)
  if (!packages.some(name => path.startsWith(name + '/'))) continue
  if (selected.has(path)) throw Error('Duplicate old graph input')
  selected.set(path,row)
}
if (selected.size !== 177) throw Error('Expected the exact 177-file accepted graph')
const files = []
async function collect(directory) {
  for (const entry of await readdir(directory,{withFileTypes:true})) {
    const path = join(directory,entry.name)
    if (entry.isSymbolicLink()) throw Error('Old graph cannot contain links')
    if (entry.isDirectory()) await collect(path)
    else {
      if (!entry.isFile()) throw Error('Old graph must contain regular files')
      const graphPath = relative(join(source,'g/node_modules'),path).replaceAll('\\','/')
      const accepted = selected.get(graphPath), sealed = inventory.get('g/node_modules/' + graphPath), bytes = await readFile(path)
      if (!accepted || !sealed || accepted.sha256 !== sealed.sha256 || accepted.bytes !== sealed.bytes || bytes.length !== sealed.bytes || hash(bytes) !== sealed.sha256) throw Error('Old graph identity mismatch: ' + graphPath)
      files.push({path:'node_modules/' + graphPath,bytes:bytes.length,sha256:hash(bytes),base64:bytes.toString('base64')})
    }
  }
}
for (const name of packages) await collect(join(source,'g/node_modules',name))
if (files.length !== selected.size) throw Error('Missing old graph file')
// First-party packages inherit the original root MIT license. The two external
// packages' own LICENSE files are already part of the unchanged 177-file graph.
const license = execFileSync('git',['show',product + ':LICENSE'],{cwd:repo})
files.push({path:'LICENSE',bytes:license.length,sha256:hash(license),base64:license.toString('base64')})
files.sort((a,b) => a.path.localeCompare(b.path,'en'))
const decoded = Buffer.from(JSON.stringify({version:1,files:files.map(({path,base64}) => ({path,base64}))}))
const capsule = gzipSync(decoded,{level:9})
const manifest = {version:1,product,format:10,packages,graphFileCount:177,fileCount:files.length,compressedBytes:capsule.length,decodedBytes:decoded.length,totalFileBytes:files.reduce((sum,file) => sum + file.bytes,0),capsuleSha256:hash(capsule),source:{inventorySha256,mapSha256,sealSha256:hash(await readFile(join(source,'evidence-seal.json')))},files:files.map(({base64,...file}) => file)}
await mkdir(destination,{recursive:true})
await writeFile(join(destination,'graph.json.gz'),capsule)
await writeFile(join(destination,'manifest.json'),JSON.stringify(manifest,null,2) + '\n')
await writeFile(join(destination,'LICENSE'),license)
console.log(JSON.stringify({...manifest,files:manifest.files.length}))
