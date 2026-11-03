import { InstructionConfigurationError, type InstructionObservationPort, type InstructionScope, type InstructionService } from './contracts.ts'
import type { InstructionObservationOwner } from './observation/owner.ts'
import { createInstructionService } from './service.ts'
import { record, scopeData } from './discovery.ts'

// Capture a capability and its receiver without invoking accessors or freezing
// the live owner. Delayed subscription must not consult a replacement method.
function method<T extends (...args: any[]) => any>(owner: unknown, name: string): T {
  if (!owner || (typeof owner !== 'object' && typeof owner !== 'function')) throw new InstructionConfigurationError(`Missing ${name} capability`)
  let object: object | null = owner as object
  while (object) {
    const descriptor = Object.getOwnPropertyDescriptor(object, name)
    if (descriptor) {
      if (!('value' in descriptor) || typeof descriptor.value !== 'function') break
      return descriptor.value.bind(owner) as T
    }
    object = Object.getPrototypeOf(object)
  }
  throw new InstructionConfigurationError(`Invalid ${name} capability`)
}

/** Each Session/view has its own IA activation and snapshots. The host retains
 * the shared observation owner, then closes it before its FsWatchService. */
export function createObservedInstructionService(options: {
  scope: InstructionScope; observation: InstructionObservationOwner
}): InstructionService {
  const input = record(options), scope = scopeData(input.scope)
  const createPort = method<InstructionObservationOwner['port']>(input.observation, 'port')
  const beginPending = method<InstructionObservationOwner['beginPending']>(input.observation, 'beginPending')
  return createInstructionService({ scope, beginPending, observation: {
    subscribe(listener) {
      // IA owns this subscription's close. Unprepared/disabled/zero-budget
      // views never subscribe, so they must not allocate owner bookkeeping.
      const port = createPort(scope)
      return method<InstructionObservationPort['subscribe']>(port, 'subscribe')(listener)
    },
  } })
}
