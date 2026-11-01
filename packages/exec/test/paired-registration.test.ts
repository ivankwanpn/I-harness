import { expect, it } from 'vitest'
import { createContext } from '@i-harness/core-plugin'
import { registerExecWithReservation } from '../src/index.ts'

it('registers the same service whose private port owns the reservation', async () => {
  const ctx = createContext(), pair = registerExecWithReservation(ctx)
  try {
    expect(ctx.services.get('exec/service')).toBe(pair.service)
    const reservation = pair.port.reserve()
    expect(pair.port.instanceId(reservation)).toBeTruthy()
    pair.port.release(reservation)
  } finally { await pair.service.dispose() }
})
