import type { InstructionService } from '@i-harness/instructions'
import type { RequestContextPin } from '@i-harness/core-agent'

/** Each exact target set retains its original service until all producers drain. */
export function instructionView(service: InstructionService) {
  let references = 1, retired = false, finished = false
  const release = (): RequestContextPin => {
    let dropped = false, completed = false
    return { async release() {
      if (completed) return
      if (!dropped) { dropped = true; references-- }
      if (references === 0) { await service.close(); finished = true }
      completed = true
    } }
  }
  const owner = release()
  return { service,
    get finished() { return finished },
    retain() { if (retired && references === 0) throw new Error('Instruction view released'); references++; return release() },
    async retire() { retired = true; await owner.release() },
    async close() {
      retired = true; await owner.release()
      if (references > 0) throw Object.assign(new Error('Original instruction producer pins remain held'), { code: 'FACT_RECOVERY_REQUIRED' })
      if (!finished) { await service.close(); finished = true }
    },
  }
}
export type InstructionView = ReturnType<typeof instructionView>
