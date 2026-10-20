import { appendFile, readFile, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, relative } from 'node:path'
import type { Tool } from '@i-harness/core-tools'
import type { SessionEventView, ManagedArtifactRef } from '@i-harness/core-session'
import type { SessionService } from '../../src/service.ts'
import { contextWorkspaceLocation } from '@i-harness/context-output'

export type Mode = 'normal' | 'code'
export const fixtureBody = 'x'.repeat(1_048_576)
export const expectedBytes = Buffer.from('{"body":"' + fixtureBody + '"}')
export const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
export const counters = () => ({ bodies: 0, getters: 0, hooks: 0, outerHooks: 0, assemblies: 0, guestFulfilled: 0 })
export type Counters = ReturnType<typeof counters>
export function fixtureTool(root: string, count: Counters): Tool {
  return { name: 'fixture_result', description: 'Writes one task-owned effect and returns the fixed body.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, isReadOnly: false,
    async execute() {
      count.bodies++; await appendFile(join(root, 'effects.jsonl'), JSON.stringify({ effect: 'fixture_result' }) + '\n')
      return { get body() { count.getters++; return fixtureBody } }
    } }
}
export function observeService(service: SessionService, count: Counters) {
  return service.onAssembly(assembly => {
    count.assemblies++
    assembly.ctx.on('tools/post-execute', input => {
      const name = (input as { name: string }).name
      if (name === 'fixture_result') count.hooks++
      if (name === 'code_exec') count.outerHooks++
    })
  })
}
export function selectedResult<T extends SessionEventView>(events: readonly T[], mode: Mode, nested?: { cellId: string; callId: string }) {
  return events.find(event => mode === 'normal'
    ? event.type === 'tool/result' && event.callId === 'fixture-original'
    : event.type === 'code/result' && event.cellId === nested?.cellId && event.callId === nested.callId)
}
export async function artifactInventory(root: string, store: string) {
  const location = await contextWorkspaceLocation(root, store)
  const files: Record<string, { bytes: number; sha256: string; text?: string }> = {}
  async function visit(directory: string) {
    let entries
    try { entries = await readdir(directory, { withFileTypes: true }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) { if (entry.name !== '.i-harness-locks') await visit(path); continue }
      if (!entry.isFile()) throw new Error('Unexpected artifact entry')
      const bytes = await readFile(path)
      files[relative(location.serviceRoot, path).replaceAll('\\', '/')] = { bytes: bytes.length, sha256: digest(bytes), ...(entry.name.endsWith('.json') ? { text: bytes.toString('utf8') } : {}) }
    }
  }
  await visit(location.serviceRoot)
  return { location, files }
}
export function committedOperation(inventory: Awaited<ReturnType<typeof artifactInventory>>, ref: ManagedArtifactRef, id: string) {
  const operations = Object.entries(inventory.files).filter(([path]) => path.endsWith('/operation.json'))
  const found = operations.map(([path, row]) => ({ path, operation: JSON.parse(row.text!) as { phase: string; owner: { sessionId: string; callId: string; operationId: string; source?: { sourceId: string } }; ref: ManagedArtifactRef } })).filter(row => row.operation.ref?.id === ref.id)
  if (found.length !== 1 || found[0]!.operation.phase !== 'committed' || found[0]!.operation.owner.sessionId !== id || !found[0]!.operation.owner.source || JSON.stringify(found[0]!.operation.ref) !== JSON.stringify(ref)) throw new Error('Original committed artifact/source evidence missing')
  const pins = Object.entries(inventory.files).filter(([path]) => path.includes('/' + ref.id + '/pins/')).map(([, row]) => JSON.parse(row.text!) as { operationId: string; documentId: string; revision: string })
  if (pins.length !== 1 || pins[0]!.documentId !== id || pins[0]!.revision !== ref.revision || pins[0]!.operationId !== found[0]!.operation.owner.operationId) throw new Error('Original document pin evidence missing')
  return { operations: operations.length, selected: found[0], pins }
}
