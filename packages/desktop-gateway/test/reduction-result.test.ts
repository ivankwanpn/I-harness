import { expect, it } from 'vitest'
import { safeCompactionDiagnostic, safeCompactionBlockedReason } from '../src/context-diagnostics.ts'
it('preserves safe closed connected outcomes and rejects arbitrary provider text', () => {
  expect(safeCompactionBlockedReason('publication-recovery-required')).toBe('publication-recovery-required')
  expect(safeCompactionBlockedReason('provider secret body')).toBeUndefined()
  expect(safeCompactionDiagnostic({ operation:'attempt', outcomeState:'blocked', publication:'recovery-required', blockedReason:'publication-recovery-required' }))
    .toEqual({operation:'attempt',outcomeState:'blocked',publication:'recovery-required',blockedReason:'publication-recovery-required'})
})
