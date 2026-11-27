import { vi } from 'vitest'
import * as core from '@i-harness/core-session'
import * as restoration from '@i-harness/core-session/internal/restoration'

type ManagedState = ReturnType<typeof core.createManagedSessionState>
type Installation = (events: Parameters<ManagedState['stage']>[0], install: () => void) => void

function interceptManagedState(intercept: (create: () => ManagedState) => ManagedState): () => void {
  const originalState = core.createManagedSessionState
  const originalClone = restoration.createManagedSessionStateFromClone
  const regular = vi.spyOn(core, 'createManagedSessionState').mockImplementation((...args) => intercept(() => originalState(...args)))
  const cloned = vi.spyOn(restoration, 'createManagedSessionStateFromClone').mockImplementation((...args) => intercept(() => originalClone(...args)))
  return () => { cloned.mockRestore(); regular.mockRestore() }
}

export function observeManagedConstruction(onCreate: () => void): () => void {
  return interceptManagedState(create => {
    onCreate()
    return create()
  })
}

export function interceptManagedInstallation(intercept: Installation): () => void {
  return interceptManagedState(create => {
    const state = create()
    const stage = state.stage
    state.stage = events => {
      const pending = stage(events)
      return Object.freeze({ ...pending, install: () => intercept(events, pending.install) })
    }
    return state
  })
}
