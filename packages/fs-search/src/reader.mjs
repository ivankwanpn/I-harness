// Fixed no-spawn reader. Current scoped Exec confines every metadata/read call.
import { open } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function readBoundedFile(path, maxBytes, onChunk) {
  if (typeof path !== 'string' || path.includes('\0') || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024) throw new Error('invalid fixed reader control')
  const metadata = { type: 'read', attempted: true, read: false, eof: false, inputBytes: 0 }
  let file
  try {
    file = await open(path, 'r')
    if (!(await file.stat()).isFile()) throw new Error('not a regular file')
    while (metadata.inputBytes < maxBytes) {
      const request = Math.min(64 * 1024, maxBytes - metadata.inputBytes)
      const bytes = Buffer.allocUnsafe(request)
      metadata.read = true
      const { bytesRead } = await file.read(bytes, 0, request, null)
      metadata.inputBytes += bytesRead
      if (!bytesRead) { metadata.eof = true; break }
      await onChunk(Buffer.from(bytes.subarray(0,bytesRead)))
    }
  } catch (error) { metadata.error = String(error.message ?? error).slice(0,256) }
  finally { await file?.close() }
  return metadata
}

async function main() {
  let input = Buffer.alloc(0)
  for await (const chunk of process.stdin) {
    if (input.length + chunk.length > 64 * 1024) throw new Error('reader control exceeds 64 KiB')
    input = Buffer.concat([input, chunk])
  }
  const { path, maxBytes } = JSON.parse(input.toString('utf8'))
  let outputError
  const failedOutput = (error) => { outputError = error }
  process.stdout.on('error', failedOutput)
  process.stderr.write(JSON.stringify({ type: 'start', attempted: true }) + '\n')
  const metadata = await readBoundedFile(path,maxBytes,async(bytes)=>{
    if(outputError) throw outputError
    await new Promise((resolve,reject)=>process.stdout.write(bytes,(error)=>error?reject(error):resolve()))
  })
  if(metadata.error) process.exitCode=2
  process.stderr.write(JSON.stringify(metadata) + '\n')
  await new Promise((resolve) => process.stderr.write('', resolve))
  process.stdout.removeListener('error', failedOutput)
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) main().catch((error) => { process.stderr.write(JSON.stringify({ type: 'read', attempted: false, read: false, eof: false, inputBytes: 0, error: String(error.message ?? error).slice(0, 256) }) + '\n'); process.exitCode = 2 })
