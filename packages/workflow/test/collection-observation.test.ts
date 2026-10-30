import { expect, it } from 'vitest'
import { createWorkflowJobStore } from '../src/runner.ts'

it('notifies the collection after creation and update without read-side notifications', () => {
  const jobs = createWorkflowJobStore(), seen: number[] = []
  const off = jobs.subscribeJobs!(() => { seen.push(jobs.list().length) })
  jobs.subscribeJobs!(() => { throw Error('isolated') })
  expect(jobs.list()).toEqual([])
  const job = jobs.createJob('s')
  jobs.update(job.id, { stdout: 'hello' })
  expect(seen).toEqual([1, 1])
  jobs.view(job.id); jobs.list(); expect(seen).toEqual([1, 1])
  off(); jobs.kill(job.id); expect(seen).toEqual([1, 1])
})
