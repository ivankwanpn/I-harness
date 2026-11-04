import { expect, it } from 'vitest'
import { checkBackendRequirements, type BackendProbe, type BackendRequirements } from '@i-harness/sandbox'
import { minimumExecutionAssurance } from '../src/transport-launch.ts'

it('reads the assurance floor from policy, defaulting to unverified (A-08)', () => {
  expect(minimumExecutionAssurance({})).toBe('unverified')
  expect(minimumExecutionAssurance({ IH_MINIMUM_EXEC_ASSURANCE: 'verified' })).toBe('verified')
  expect(minimumExecutionAssurance({ IH_MINIMUM_EXEC_ASSURANCE: 'experimental' })).toBe('experimental')
  expect(minimumExecutionAssurance({ IH_MINIMUM_EXEC_ASSURANCE: 'bogus' })).toBe('unverified')
})

it('refuses an experimental backend when the floor is verified', () => {
  const probe: BackendProbe = { id: 'experimental', availability: 'available', assurance: 'experimental', features: {
    writeIsolation: true, readIsolation: true, denyPaths: true, pipes: true, pty: false, retainedTree: false } }
  const requirements: BackendRequirements = { writeIsolation: true, readIsolation: false, denyPaths: false, transport: 'pipe', lifetime: 'complete-tree', minimumAssurance: 'verified' }
  expect(checkBackendRequirements(probe, requirements)).toEqual({ ok: false, missing: ['assurance'] })
  expect(checkBackendRequirements(probe, { ...requirements, minimumAssurance: 'experimental' })).toEqual({ ok: true })
})
