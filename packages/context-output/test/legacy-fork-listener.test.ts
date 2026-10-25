import { expect, it, vi } from 'vitest'
import { getEventListeners } from 'node:events'
const fault = vi.hoisted(() => {
  const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener
  const state = { signal: undefined as AbortSignal | undefined, install: false, removal: false }
  EventTarget.prototype.addEventListener = function (...args: Parameters<typeof add>) {
    Reflect.apply(add, this, args)
    if (this === state.signal && state.install) { state.install = false; throw Error('Original listener installed then threw') }
  }
  EventTarget.prototype.removeEventListener = function (...args: Parameters<typeof remove>) {
    if (this === state.signal && state.removal) { state.removal = false; throw Error('Original listener removal failed') }
    Reflect.apply(remove, this, args)
  }
  return state
})
import { legacyFixture } from './legacy-fork-fixture.ts'

it.each([false, true])('settles possible intrinsic installation and joins original removal debt=%s', async debt => {
  const f = await legacyFixture(), controller = new AbortController()
  try {
    fault.signal = controller.signal; fault.install = true; fault.removal = debt
    await expect(f.run(false, capture => { capture.signal = controller.signal })).rejects.toThrow(/listener/)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(debt ? 1 : 0)
    await f.service().close()
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  } finally { fault.install = fault.removal = false; await f.close(); fault.signal = undefined }
})
