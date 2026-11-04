import { expect, it } from 'vitest'
import { reportTaskProjectionIssues } from '../src/task-projection-diagnostics.ts'

it('reports projection issues at reload without failing the reload', async () => {
  const warnings: string[] = []
  const issues = await reportTaskProjectionIssues({
    taskProjectionIntegrity: async () => [{ kind: 'missing-child-session', taskId: 't1', childSessionId: 'c1' }],
  }, 'session-1', message => warnings.push(message))
  expect(issues).toHaveLength(1)
  expect(warnings).toEqual(['[desktop] task projection issues for session-1: missing-child-session'])
})

it('stays silent when the projection is consistent or unavailable', async () => {
  const warnings: string[] = []
  await reportTaskProjectionIssues({ taskProjectionIntegrity: async () => [] }, 'session-1', message => warnings.push(message))
  await reportTaskProjectionIssues({}, 'session-1', message => warnings.push(message))
  await reportTaskProjectionIssues({ taskProjectionIntegrity: async () => { throw new Error('no owner') } }, 'session-1', message => warnings.push(message))
  expect(warnings).toEqual([])
})
