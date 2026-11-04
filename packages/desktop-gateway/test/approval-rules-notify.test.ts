import { expect, it, vi } from 'vitest'
import { notifyApprovalRuleChanges, type ApprovalRulesAdapter } from '../src/approval-rules.ts'

it('announces every mutation that changes the durable rule set (NG-12)', () => {
  const adapter = {
    grant: vi.fn(() => ({ id: 'rule' })),
    revoke: vi.fn(),
    removeSession: vi.fn(),
    state: vi.fn(() => ({ rules: [], candidates: [] })),
    attach: vi.fn(),
    attachOwned: vi.fn(),
    forget: vi.fn(),
    list: vi.fn(() => []),
  } as unknown as ApprovalRulesAdapter
  let changes = 0
  const wrapped = notifyApprovalRuleChanges(adapter, () => { changes += 1 })
  expect(wrapped.grant({} as never, 's', { scope: 'workspace', expiresAt: 1 })).toEqual({ id: 'rule' })
  expect(changes).toBe(1)
  wrapped.revoke('w', 'rule')
  expect(adapter.revoke).toHaveBeenCalledWith('w', 'rule')
  expect(changes).toBe(2)
  wrapped.removeSession('s')
  expect(changes).toBe(3)
  wrapped.state('w', [])
  expect(changes).toBe(3)
})
