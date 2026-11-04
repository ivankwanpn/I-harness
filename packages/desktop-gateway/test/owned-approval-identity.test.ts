import { describe, expect, it } from 'vitest'
import { approvalPolicyIdentityFromSources } from '../src/approval-policy-identity.ts'

describe('owned approval identity', () => {
  it('reassesses live plan and registry authority and fails closed when unavailable', () => {
    let plan = { active: false }
    let catalog: unknown = [{ name: 'read' }]
    let available = true
    const sources = () => { if (!available) throw Error('retired'); return { plan, roles: [], catalog, deferred: [], modelTools: [], mcp: [], agents: [] } }
    const options = { workspace: 'workspace', sandbox: 'workspace-write', approval: 'ask', project: () => undefined, hookConfigs: [], grantPaths: [], pluginAuthority: {} }
    const first = approvalPolicyIdentityFromSources(sources, options)
    expect(first).toBeDefined()
    plan = { active: true }
    const second = approvalPolicyIdentityFromSources(sources, options)
    expect(second?.revision).not.toBe(first?.revision)
    // D-05: tool-surface changes must not invalidate a prepared approval.
    catalog = [{ name: 'write' }]
    expect(approvalPolicyIdentityFromSources(sources, options)?.revision).toBe(second?.revision)
    // A real policy input (sandbox mode) still changes the identity.
    const third = approvalPolicyIdentityFromSources(sources, { ...options, sandbox: 'read-only' })
    expect(third?.revision).not.toBe(second?.revision)
    available = false
    expect(approvalPolicyIdentityFromSources(sources, options)).toBeUndefined()
  })
})
