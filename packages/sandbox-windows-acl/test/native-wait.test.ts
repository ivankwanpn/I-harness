import { describe, expect, it } from 'vitest'
import { createRegisteredWait } from '../src/native-wait.ts'
import { WaitDrainTransportError } from '../src/native-wait-bridge.ts'

describe('registered wait ownership', () => {
  it('joins unregister and retains callback until acknowledgement', async () => {
    let signal!: () => void
    let finish!: (code: number) => void
    let releases = 0
    let unregisters = 0
    const wait = createRegisteredWait({
      register: callback => { signal = callback; return 1 },
      unregister: () => { unregisters++; return new Promise(resolve => { finish = resolve }) },
      release: () => { releases++ },
    })
    signal()
    await wait.signalled
    const first = wait.close()
    const second = wait.close()
    expect(unregisters).toBe(1)
    expect(releases).toBe(0)
    finish(0)
    await Promise.all([first, second])
    expect(releases).toBe(1)
  })
  it('retains registration on failure and retries without releasing it', async () => {
    let releases = 0
    let attempts = 0
    const wait = createRegisteredWait({
      register: () => 7,
      unregister: async () => ++attempts === 1 ? 5 : 0,
      release: () => { releases++ },
    })
    await expect(wait.close()).rejects.toMatchObject({ api: 'UnregisterWaitEx', win32Code: 5 })
    expect(releases).toBe(0)
    await wait.close()
    expect(attempts).toBe(2)
    expect(releases).toBe(1)
  })
})

it('pins unknown unregister outcome and never resubmits it on explicit cleanup retry', async () => {
  const unknown = new WaitDrainTransportError('unknown', 'worker exited after dispatch')
  let unregisters = 0, releases = 0
  const wait = createRegisteredWait({
    register: () => 1,
    unregister: async () => { unregisters++; throw unknown },
    release: () => { releases++ },
  })
  await expect(wait.close()).rejects.toBe(unknown)
  await expect(wait.close()).rejects.toBe(unknown)
  expect(unregisters).toBe(1)
  expect(releases).toBe(0)
})

it('does not resubmit an acknowledged unregister when releasing the callback fails', async () => {
  let unregisters = 0
  let releases = 0
  const wait = createRegisteredWait({
    register: () => 1,
    unregister: async () => { unregisters++; return 0 },
    release: () => { if (++releases === 1) throw new Error('release failed') },
  })
  await expect(wait.close()).rejects.toThrow('release failed')
  await wait.close()
  expect(unregisters).toBe(1)
  expect(releases).toBe(2)
})
