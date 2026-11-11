import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, writeFile, lstat, realpath } from 'node:fs/promises'
import { resolve, relative, sep } from 'node:path'
import { createHash } from 'node:crypto'
import type { ManagedArtifactRef, ResultCodec } from '@i-harness/core-session'
import type { ContextOutputOptions, ContextOutputService } from '../src/types.ts'

export const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
export const vectorBody = (size: number) => Buffer.concat([Buffer.alloc(Math.min(size, 65536), 65), Buffer.alloc(Math.min(Math.max(size - 65536, 0), 65536), 66), Buffer.alloc(Math.max(size - 131072, 0), 67)])
export const evidence = resolve(process.env.IH_RESULT_INTEGRITY_EVIDENCE_ROOT ?? resolve(import.meta.dirname, '../../../.tmp/r4a-integrity-local'))
export function unsealed() {
  if (existsSync(resolve(evidence, 'evidence-seal.json'))) throw new Error('Result integrity evidence sealed; choose a fresh IH_RESULT_INTEGRITY_EVIDENCE_ROOT')
  if (!process.env.IH_CONFIG_DIR) throw new Error('Set shell IH_CONFIG_DIR before importing result fixtures')
}
unsealed()
// Load the product after isolation checks, during test collection. A cold
// module graph must not consume the first integrity case's I/O deadline.
const { createContextOutputService } = await import('../src/index.ts')

export async function fixture(label: string, extra: Partial<Pick<ContextOutputOptions, 'authorizeResult' | 'documentDeletions'>> = {}) {
  unsealed(); await mkdir(evidence, { recursive: true })
  const root = await mkdtemp(resolve(evidence, `${label}-`)), settingsPath = resolve(root, 'settings.json')
  await writeFile(settingsPath, '{}')
  const options = { root, workspaceId: 'integrity', ...extra }
  let service = createContextOutputService(options)
  return { root, get service() { return service }, directory: (ref: Pick<ManagedArtifactRef, 'id'>) => resolve(root, 'context-output', hash('integrity'), 'managed-v1', ref.id),
    async reopen() { await service.close(); service = createContextOutputService(options); return service },
    async close() { await service.close() },
  }
}
export async function commit(service: ContextOutputService, operationId: string, bytes: Uint8Array, codec: ResultCodec = 'text-utf8-v1', sessionId = 'owner') {
  const scope = service.registerResultScope({ operationId, sessionId, callId: operationId }, () => true)
  const sink = await service.beginResult(scope, codec)
  for (let offset = 0; offset < bytes.length; offset += 65536) await sink.write(bytes.subarray(offset, offset + 65536))
  const settled = await sink.finish('complete')
  if (settled.kind !== 'committed') throw new Error(`Authentic fixture did not commit: ${settled.kind}`)
  return { ref: settled.ref, scope, sink }
}
export async function inventory(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  async function visit(path: string) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = resolve(path, entry.name)
      if (entry.isSymbolicLink()) { result[relative(root, child)] = 'fixture-link'; continue }
      if (entry.isDirectory()) await visit(child)
      else result[relative(root, child)] = hash(await readFile(child))
    }
  }
  await visit(root); return result
}
export async function contained(root: string, target: string) {
  const base = await realpath(root), parent = await realpath(resolve(target, '..'))
  if (parent !== base && !parent.startsWith(base + sep)) throw new Error('Fixture mutation escaped task root')
  if (!(await lstat(root)).isDirectory()) throw new Error('Fixture root missing')
}
export async function record(name: string, value: unknown) {
  unsealed()
  const path = resolve(evidence, `${name}.json`)
  await writeFile(path, JSON.stringify(value, null, 2), { flag: 'wx' })
}
