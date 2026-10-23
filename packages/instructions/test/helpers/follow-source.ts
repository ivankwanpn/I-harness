import type { InstructionService, InstructionSnapshot } from '../../src/index.ts'
import { watchdog } from './observation-fixture.ts'

/** Callback-driven reconciliation plus one watchdog; no sleep/stat polling. */
export function follow(service: InstructionService) {
  const waiters = new Set<{ predicate: (value: InstructionSnapshot) => boolean; resolve: (value: InstructionSnapshot) => void; reject: (error: unknown) => void }>()
  let running: Promise<void> | undefined, again = false, closed = false
  function schedule() {
    if (closed) return
    again = true
    if (running) return
    running = Promise.resolve().then(async () => {
      while (again && !closed) {
        again = false; const value = await service.prepare([])
        for (const waiter of [...waiters]) if (waiter.predicate(value)) { waiters.delete(waiter); waiter.resolve(value) }
      }
    }).catch(error => { for (const waiter of waiters) waiter.reject(error); waiters.clear() }).finally(() => { running = undefined; if (again && !closed) schedule() })
  }
  const unsubscribe = service.subscribe(schedule)
  return { at(predicate: (value: InstructionSnapshot) => boolean) {
    return watchdog(new Promise<InstructionSnapshot>((resolve, reject) => {
      if (predicate(service.snapshot())) resolve(service.snapshot())
      else { waiters.add({ predicate, resolve, reject }); schedule() }
    }), 15000)
  }, async close() { closed = true; unsubscribe(); await running } }
}
