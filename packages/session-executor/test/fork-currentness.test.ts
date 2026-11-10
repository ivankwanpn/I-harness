import { expect, it } from 'vitest'
import { createCliForkHost } from '../src/lifecycle/fork-handoff.ts'
import { assertArtifactCurrent, createArtifactCurrentGuard } from '../../session-persistence/src/coordinator/artifact-path-association.ts'
import type { SessionCoordinator } from '@i-harness/session-persistence'

it('keeps supplied fork availability callbacks between immediate proof boundaries', () => {
 const coordinator = { withSessionBindingObservation() {}, withExistingSessionBindingObservation() {} } as unknown as SessionCoordinator
 const events: string[] = []
 let current = false
 const capture = { kind: 'ready' as const, key: 'fixture', assertCurrent() { events.push('proof'); if (!current) throw Error('changed source') } }
 const host = createCliForkHost({ workspace: process.cwd(), coordinator, assertAvailable() { events.push('callback'); current = false } })
 const check = createArtifactCurrentGuard(() => { assertArtifactCurrent(capture); host.assertAvailable(); assertArtifactCurrent(capture) })
 expect(check).toThrow('changed source')
 expect(events).toEqual(['proof'])
 events.length = 0; current = true
 expect(check).toThrow('changed source')
 expect(events).toEqual(['proof', 'callback', 'proof'])
})
