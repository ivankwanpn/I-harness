import { expect, it } from 'vitest'
import { agentAbortedError } from '../src/agent/aborted.ts'

it('marks an owner abort with the stable AGENT_ABORTED code (A-11)', () => {
  const error = agentAbortedError()
  expect(error).toMatchObject({ code: 'AGENT_ABORTED' })
  expect(error.message).toBe('agent aborted')
})
