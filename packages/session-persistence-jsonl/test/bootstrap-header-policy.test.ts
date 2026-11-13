import { expect, it } from 'vitest'
import { sameImmutableBootstrapHeader } from '../src/backend/bootstrap-stage.ts'

function header(version = 11): Record<string, unknown> {
  return { formatVersion: version, sessionId: 'child', createdAt: '2026-10-23T00:00:00.000Z',
    journal: { version: 1, legacyBodyBytes: 0 }, semanticSeed: { manifestDigest: 'original' },
    parentSession: 'parent', origin: 'fork', seedLength: 3, delegationDepth: 1,
    subagentProtocolVersion: 1, subagentTaskId: 'task', subagentAgentPath: 'agent' }
}
it.each([[11,11],[11,12],[11,13],[11,14],[12,12],[12,13],[12,14],[13,13],[13,14],[14,14]])('permits original supported storage %s to %s with presentation edits', (from,to) => {
  const original = header(from)
  expect(sameImmutableBootstrapHeader({ ...original, formatVersion: to, title: 'later', workspaceId: 'workspace', archived: true, modelSelection: { model: 'later' } }, original)).toBe(true)
})
it.each([[14,13],[13,12],[12,11],[11,10],[11,15],[14,15],[11,11.5],[11,12.5],[11.5,14]])('refuses downgrade or unsupported storage %s to %s', (from,to) => {
  expect(sameImmutableBootstrapHeader({ ...header(from), formatVersion: to }, header(from))).toBe(false)
})
it.each(['sessionId','createdAt','journal','semanticSeed','parentSession','origin','seedLength','delegationDepth','subagentProtocolVersion','subagentTaskId','subagentAgentPath'])('refuses changed immutable %s during a supported upgrade', key => {
  const original = header()
  expect(sameImmutableBootstrapHeader({ ...original, formatVersion: 14, [key]: 'changed' }, original)).toBe(false)
})
it.each([undefined,null,false,0])('does not lose a falsey changed immutable value %s', value => {
  const original = header()
  expect(sameImmutableBootstrapHeader({ ...original, subagentProtocolVersion: value }, original)).toBe(false)
})
