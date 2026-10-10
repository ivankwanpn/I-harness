import { createHash } from 'node:crypto'
import { fork } from 'node:child_process'
import { crc32 } from 'node:zlib'

const MAX_BYTES = 10 * 1024 * 1024
const MAX_PENDING = 32
const cache = new Map<string, ImageInfo | string>()
const waiting: Array<() => void> = []
let active = 0
interface ImageInfo { width: number; height: number; frames: number }
/** Input corruption/policy refusal; infrastructure failures and aborts are separate. */
export class InvalidImageError extends Error {
  constructor(reason: string) { super(`Invalid image: ${reason}`); this.name = 'InvalidImageError' }
}
function invalid(reason: string): never { throw new InvalidImageError(reason) }

function pngIntegrity(bytes: Buffer) {
  let offset = 8, chunks = 0, idat = false, ended = false
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) invalid('truncated PNG chunk')
    const size = bytes.readUInt32BE(offset), end = offset + 12 + size
    if (end > bytes.length) invalid('truncated PNG chunk')
    const name = bytes.toString('ascii', offset + 4, offset + 8)
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) invalid('PNG checksum mismatch')
    if (chunks++ === 0 && (name !== 'IHDR' || size !== 13)) invalid('missing PNG header')
    if (name === 'IDAT') idat = true
    if (name === 'IEND') { if (size || end !== bytes.length) invalid('invalid PNG end'); ended = true }
    offset = end
  }
  if (!idat || !ended) invalid('incomplete PNG')
}
function gifIntegrity(bytes: Buffer): number {
  if (bytes.length < 14) invalid('truncated GIF header')
  let offset = 13 + ((bytes[10] & 128) ? 3 * 2 ** ((bytes[10] & 7) + 1) : 0), frames = 0
  const blocks = () => {
    while (offset < bytes.length) {
      const length = bytes[offset++]
      if (!length) return
      offset += length
      if (offset > bytes.length) invalid('truncated GIF data')
    }
    invalid('missing GIF data terminator')
  }
  while (offset < bytes.length) {
    const block = bytes[offset++]
    if (block === 0x3b) { if (offset !== bytes.length || !frames) invalid('invalid GIF trailer'); return frames }
    if (block === 0x21) { offset++; blocks() }
    else if (block === 0x2c) {
      if (offset + 9 > bytes.length) invalid('truncated GIF frame header')
      const packed = bytes[offset + 8]
      offset += 9 + ((packed & 128) ? 3 * 2 ** ((packed & 7) + 1) : 0)
      offset++ // LZW code size; full pixel correctness is checked by the decoder.
      blocks(); frames++
      if (frames > 100) invalid('animation exceeds frame limit')
    } else invalid('invalid GIF block')
  }
  invalid('missing GIF trailer')
}
function input(image: unknown): { bytes: Buffer; mime: string; key: string; frames?: number } {
  if (!image || typeof image !== 'object') invalid('expected an image object')
  const { mediaType, dataBase64 } = image as { mediaType?: unknown; dataBase64?: unknown }
  if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(String(mediaType))) invalid('unsupported media type')
  if (typeof dataBase64 !== 'string' || !dataBase64.length || dataBase64.length > Math.ceil(MAX_BYTES / 3) * 4) invalid('empty image or image exceeds 10 MiB')
  if (dataBase64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(dataBase64)) invalid('noncanonical base64')
  const bytes = Buffer.from(dataBase64, 'base64')
  if (!bytes.length || bytes.length > MAX_BYTES || bytes.toString('base64') !== dataBase64) invalid('noncanonical base64 or image exceeds 10 MiB')
  const mime = String(mediaType)
  const detected = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png'
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg'
      : /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6)) ? 'image/gif'
        : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : undefined
  if (detected !== mime) invalid('bytes do not match declared media type')
  if (mime === 'image/png') pngIntegrity(bytes)
  if (mime === 'image/webp' && bytes.readUInt32LE(4) + 8 !== bytes.length) invalid('incomplete WebP container')
  const frames = mime === 'image/gif' ? gifIntegrity(bytes) : undefined
  return { bytes, mime, frames, key: `${mime}:${createHash('sha256').update(bytes).digest('hex')}` }
}

async function acquire(signal?: AbortSignal) {
  signal?.throwIfAborted()
  if (active < 2) { active++; return }
  if (waiting.length >= MAX_PENDING) throw new Error('Image validator is busy; retry after pending images finish')
  await new Promise<void>((resolve, reject) => {
    const ready = () => { signal?.removeEventListener('abort', abort); active++; resolve() }
    const abort = () => { const index = waiting.indexOf(ready); if (index >= 0) waiting.splice(index, 1); reject(signal?.reason ?? new Error('Image validation aborted')) }
    waiting.push(ready)
    signal?.addEventListener('abort', abort, { once: true })
  })
}
function release() { active--; waiting.shift()?.() }

/** Decode in a disposable process: a deadline/abort kills native work, not just its Promise. */
export async function validateImage(image: unknown, options: { signal?: AbortSignal } = {}): Promise<ImageInfo> {
  options.signal?.throwIfAborted()
  const { bytes, mime, key, frames } = input(image)
  const hit = cache.get(key)
  if (hit !== undefined) {
    cache.delete(key); cache.set(key, hit)
    if (typeof hit === 'string') invalid(hit)
    return { ...hit }
  }
  await acquire(options.signal)
  try {
    options.signal?.throwIfAborted()
    const result = await new Promise<ImageInfo>((resolve, reject) => {
      const child = fork(new URL('./worker.mjs', import.meta.url), [], {
        execArgv: [], serialization: 'advanced', ...{ windowsHide: true }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: {
          ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
          ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}),
          // The shipped gateway forks Electron's executable in Node mode.
          // Omitting this flag launches the desktop shell instead of the decoder.
          ...(process.versions.electron || process.env.ELECTRON_RUN_AS_NODE === '1' ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
        },
      })
      let settled = false
      const finish = (error?: unknown, info?: ImageInfo) => {
        if (settled) return
        settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', abort)
        const deliver = () => { if (error) reject(error); else resolve(info!) }
        // Keep the concurrency slot until the native decoder process has exited.
        if (child.pid && child.exitCode === null && child.signalCode === null) { child.once('exit', deliver); child.kill() }
        else deliver()
      }
      const abort = () => finish(options.signal?.reason ?? new Error('Image validation aborted'))
      const timer = setTimeout(() => finish(new Error('Image validation timed out after 5 seconds')), 5000)
      options.signal?.addEventListener('abort', abort, { once: true })
      child.once('error', error => finish(new Error(`Image validator unavailable: ${error.message}`)))
      child.once('exit', () => finish(new Error('Image validator exited before decoding')))
      child.once('message', (value: unknown) => {
        const reply = value as { info?: ImageInfo; invalid?: string; unavailable?: string }
        if (reply?.invalid) finish(new InvalidImageError(reply.invalid))
        else if (reply?.info && Number.isInteger(reply.info.width) && Number.isInteger(reply.info.height) && Number.isInteger(reply.info.frames)) finish(undefined, reply.info)
        else finish(new Error(`Image validator unavailable: ${reply?.unavailable ?? 'invalid decoder response'}`))
      })
      child.send({ bytes, mime, frames }, error => { if (error) finish(new Error('Image validator communication failed')) })
    })
    cache.set(key, result)
    return { ...result }
  } catch (error) {
    if (error instanceof InvalidImageError) cache.set(key, error.message.replace(/^Invalid image: /, ''))
    throw error
  } finally {
    while (cache.size > 256) cache.delete(cache.keys().next().value!)
    release()
  }
}
