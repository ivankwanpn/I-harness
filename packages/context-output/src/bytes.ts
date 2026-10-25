import { streamJsonData } from '@i-harness/core-session'

export function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Context operation aborted', 'AbortError')
}
export function boundary(bytes: Uint8Array, offset: number): boolean {
  return offset === bytes.length || (bytes[offset]! & 0xc0) !== 0x80
}
export function floorBoundary(bytes: Uint8Array, offset: number): number {
  let end = Math.min(offset, bytes.length)
  while (end > 0 && !boundary(bytes, end)) end--
  return end
}
export function prefix(bytes: Buffer, maxBytes: number): Buffer {
  return bytes.subarray(0, floorBoundary(bytes, maxBytes))
}
export function serializedBytes(value: unknown): number {
  let bytes = 0
  for (const text of streamJsonData(value)) { bytes += Buffer.byteLength(text); if (!Number.isSafeInteger(bytes)) throw Error('Context encoded size overflow') }
  return bytes
}

// Overlap keeps bounded literal search terms visible across lexical chunk edges.
export function* lexicalChunks(bytes: Buffer): Generator<{ offset: number; text: string }> {
  let offset = 0
  while (offset < bytes.length) {
    const end = floorBoundary(bytes, offset + 4096)
    yield { offset, text: bytes.subarray(offset, end).toString('utf8') }
    if (end === bytes.length) break
    offset = floorBoundary(bytes, end - 1024)
  }
}
