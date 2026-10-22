import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile, mkdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gzipSync, gunzipSync } from 'node:zlib'
import { afterEach, expect, it } from 'vitest'
import { extractFormat10Predecessor, predecessorFixture } from './helpers/format10-predecessor.ts'

const roots: string[] = []
afterEach(async () => { for(const root of roots.splice(0)) await rm(root,{recursive:true,force:true}) })
it.each(['missing','corrupt','file-hash','traversal','duplicate','count','oversize'])('strictly refuses %s predecessor data before extraction', async kind => {
  const root = await mkdtemp(join(tmpdir(),'predecessor-invalid-')); roots.push(root)
  const fixture = join(root,'fixture'), target = join(root,'target'); await mkdir(fixture)
  const manifest = JSON.parse(await readFile(new URL('manifest.json',predecessorFixture),'utf8'))
  let capsule = await readFile(new URL('graph.json.gz',predecessorFixture))
  if(kind === 'corrupt') capsule[40] = capsule[40]! ^ 1
  if(['file-hash','traversal','duplicate'].includes(kind)) {
    const content = JSON.parse(gunzipSync(capsule).toString('utf8'))
    if(kind === 'file-hash') content.files[0].base64 = Buffer.from('wrong bytes').toString('base64')
    if(kind === 'traversal') content.files[1].path = '../escape'
    if(kind === 'duplicate') content.files[1].path = content.files[0].path
    const decoded = Buffer.from(JSON.stringify(content)); capsule = gzipSync(decoded)
    manifest.decodedBytes = decoded.length; manifest.compressedBytes = capsule.length
    manifest.capsuleSha256 = createHash('sha256').update(capsule).digest('hex')
  }
  if(kind === 'count') manifest.fileCount++
  if(kind === 'oversize') manifest.decodedBytes = 1024*1024*1024
  await writeFile(join(fixture,'manifest.json'),JSON.stringify(manifest))
  if(kind !== 'missing') await writeFile(join(fixture,'graph.json.gz'),capsule)
  await expect(extractFormat10Predecessor(target,pathToFileURL(fixture+'/'))).rejects.toThrow()
  await expect(stat(target)).rejects.toMatchObject({code:'ENOENT'})
})
