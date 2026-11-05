import { join, posix, resolve, win32 } from 'node:path'

/** Refuse an id that could escape the store root (separators, drive/absolute
 *  prefixes, or the dot segments). Generated ids never contain these. */
export function assertSafeSessionId(id: string): void {
  if (typeof id !== 'string' || id.length === 0) throw new TypeError('session id must be a non-empty string')
  if (id.includes('/') || id.includes('\\') || id === '.' || id === '..') throw new TypeError(`session id ${JSON.stringify(id)} is not a safe path segment`)
  if (posix.isAbsolute(id) || win32.parse(id).root !== '') throw new TypeError(`session id ${JSON.stringify(id)} must not be a path`)
}

export function sessionDirectory(root: string, id: string): string {
  assertSafeSessionId(id)
  return join(resolve(root), id)
}

export function generationFileName(version: number): string {
  return `session.v${version}.jsonl`
}

export function generationPath(root: string, id: string, version: number): string {
  return join(sessionDirectory(root, id), generationFileName(version))
}

export function sidecarDirectory(root: string, id: string): string {
  return join(sessionDirectory(root, id), 'side')
}

export function sidecarPath(root: string, id: string, digest: string): string {
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new TypeError('sidecar digest must be a 64-char lowercase hex string')
  return join(sidecarDirectory(root, id), digest)
}

export function temporaryPath(root: string, id: string, tag: string): string {
  return join(sessionDirectory(root, id), `.tmp-${tag}-${process.pid}-${Date.now().toString(36)}`)
}
