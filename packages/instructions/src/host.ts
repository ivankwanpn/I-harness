import type { InstructionScope, InstructionService } from './contracts.ts'
import type { InstructionObservationOwner } from './observation/owner.ts'
import { createInstructionService } from './service.ts'

/** Each Session/view has its own IA activation and snapshots. The host retains
 * the shared observation owner, then closes it before its FsWatchService. */
export function createObservedInstructionService(options: {
  scope: InstructionScope; observation: InstructionObservationOwner
}): InstructionService {
  return createInstructionService({ scope: options.scope, observation: options.observation.port(options.scope) })
}
