import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, relative, isAbsolute } from 'node:path'
import { createInstructionService } from '../../src/service.ts'
import type { InstructionObservationEvent, InstructionObservationPort, InstructionObservationState, InstructionScope, InstructionWatchInterest, InstructionService } from '../../src/contracts.ts'

export class Observation implements InstructionObservationPort {
  state: InstructionObservationState = { revision: 0, available: true, pending: [] }
  listener?: (event: InstructionObservationEvent) => void
  interests: readonly InstructionWatchInterest[] = []
  subscriptions = 0; updates = 0; closes = 0
  duringUpdate?: () => Promise<void>
  closeError?: Error
  subscribe(listener: (event: InstructionObservationEvent) => void) {
    this.subscriptions++; this.listener = listener
    return {
      update: async (interests: readonly InstructionWatchInterest[]) => { this.updates++; this.interests = interests; await this.duringUpdate?.(); return this.state },
      close: async () => { this.closes++; if (this.closeError) throw this.closeError },
    }
  }
  emit(paths: string[] = [], kind: InstructionObservationEvent['kind'] = 'changed', pending = this.state.pending, available = true) {
    this.state = { revision: this.state.revision + 1, available, pending }
    this.listener?.({ ...this.state, kind, paths })
  }
}
export async function fixture() {
  const parent = resolve(tmpdir())
  const root = await fs.mkdtemp(join(parent, 'ia-'))
  const observation = new Observation()
  const services: InstructionService[] = []
  return {
    root, observation,
    path: (...parts: string[]) => join(root, ...parts),
    async write(path: string, text: string | Buffer) { const file = join(root, path); await fs.mkdir(dirname(file), { recursive: true }); await fs.writeFile(file, text); return file },
    async dir(path: string) { const dir = join(root, path); await fs.mkdir(dir, { recursive: true }); return dir },
    service(scope: Partial<InstructionScope> = {}) { const service = createInstructionService({ scope: { cwd: root, roots: [root], globalSources: [], enabled: true, maxBytes: 24000, ...scope }, observation }); services.push(service); return service },
    async cleanup() {
      await Promise.allSettled(services.map(s => s.close()))
      const owned = relative(parent, resolve(root))
      if (isAbsolute(owned) || owned.startsWith('..') || !owned.startsWith('ia-') || owned.includes('/') || owned.includes('\\')) throw new Error('Unsafe fixture cleanup')
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}
export type Fixture = Awaited<ReturnType<typeof fixture>>
export function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }
