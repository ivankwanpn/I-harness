import {forwardRequiredTaskRegistry} from './required-settlement.ts'
import type { TaskRegistry } from './types.ts'
import { associateTaskSaveFacade } from './save-owner.ts'
import { forwardColdBindings } from './cold-bindings.ts'

/** Mount admission only. Data and cleanup stay with the one original registry;
 * restoration retains that private owner rather than temporarily unlocking it. */
export function createTaskStartupFacade(owner: TaskRegistry, assertWork: () => void): TaskRegistry {
  const facade: TaskRegistry = {
    ...owner,
    assertReady() { assertWork() },
    submit(...args) { assertWork(); return owner.submit(...args) },
    claim(...args) { assertWork(); return owner.claim(...args) },
    terminalize(...args) { assertWork(); return owner.terminalize(...args) },
    cancelTree(...args) { assertWork(); return owner.cancelTree(...args) },
    updateNotification(...args) { assertWork(); return owner.updateNotification(...args) },
    bindForegroundHandoff(...args) {
      assertWork()
      const original = owner.bindForegroundHandoff(...args)
      return () => { assertWork(); return original() }
    },
    restore(...args) { assertWork(); return owner.restore(...args) },
    retainResult(...args) { assertWork(); return owner.retainResult(...args) },
    async prepareResult(...args) { assertWork(); return owner.prepareResult(...args) },
    async qualifyRestoredResults() { assertWork(); return owner.qualifyRestoredResults() },
    async readResult(...args) { assertWork(); return owner.readResult(...args) },
    async save() { assertWork(); await owner.save() },
    async flushPersistence() { await owner.flushPersistence() },
  }
  associateTaskSaveFacade(facade, owner)
  forwardColdBindings(facade, owner)
  forwardRequiredTaskRegistry(facade,owner)
  return Object.freeze(facade)
}
