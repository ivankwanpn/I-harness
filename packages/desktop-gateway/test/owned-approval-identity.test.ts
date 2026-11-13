import { describe, expect, it } from 'vitest'
import { approvalPolicyIdentityFromSources, type ApprovalIdentityOptions } from '../src/approval-policy-identity.ts'

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
  it('keeps project, hooks, roles and execution policy revisions in the authority identity', () => {
    const sources = () => ({ plan: { active: false }, roles: [] as unknown[] })
    const options: ApprovalIdentityOptions = { workspace: 'workspace', sandbox: 'workspace-write', approval: 'ask', project: () => undefined, hookConfigs: [], grantPaths: [], pluginAuthority: {} }
    const original = approvalPolicyIdentityFromSources(sources, options)!
    expect(original).toBeDefined()
    const changed: ApprovalIdentityOptions[] = [
      { ...options, project: () => ({ id: 'project', name: 'Project', roots: ['workspace'], primaryRoot: 'workspace' }) },
      { ...options, approval: 'ask-all' },
      { ...options, sandbox: 'read-only' },
      { ...options, hookConfigs: ['original-hook'], hookAuthority: () => ({ revision: 'changed-hook' }) },
      { ...options, pluginAuthority: { revision: 'changed-plugin' } },
      { ...options, executionAuthority: () => ({ kind: 'unbound', revision: 'changed', workspaceRoot: 'workspace' }) },
    ]
    for (const current of changed) {
      const identity = approvalPolicyIdentityFromSources(sources, current)
      expect(identity).toBeDefined()
      expect(identity!.revision).not.toBe(original.revision)
    }
    expect(approvalPolicyIdentityFromSources(() => ({ ...sources(), roles: [{ name: 'changed-role' }] }), options)?.revision).not.toBe(original.revision)
    for (const kind of ['revoked', 'unavailable'] as const) {
      expect(approvalPolicyIdentityFromSources(sources, { ...options, executionAuthority: () => ({ kind, revision: 'original', reason: 'original authority unavailable' }) })).toBeUndefined()
    }
    expect(approvalPolicyIdentityFromSources(sources, { ...options, hookConfigs: ['original-hook'], hookAuthority: () => undefined })).toBeUndefined()
  })
})
