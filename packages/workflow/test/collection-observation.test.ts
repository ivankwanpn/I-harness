import { expect, it, vi } from 'vitest'
import { createWorkflowJobStore } from '../src/runner.ts'

it('notifies the collection after creation and update without read-side notifications', () => {
  const jobs = createWorkflowJobStore(), seen: number[] = []
  jobs.subscribeJobs!(() => { throw Error('isolated first consumer') })
  const off = jobs.subscribeJobs!(() => { seen.push(jobs.list().length) })
  jobs.subscribeJobs!(() => { throw Error('isolated') })
  expect(jobs.list()).toEqual([])
  const job = jobs.createJob('s')
  jobs.update(job.id, { stdout: 'hello' })
  expect(seen).toEqual([1, 1])
  jobs.view(job.id); jobs.list(); expect(seen).toEqual([1, 1])
  jobs.kill(job.id); expect(seen).toEqual([1, 1, 1]); expect(jobs.view(job.id).status).toBe('killed')
  off(); jobs.createJob('after-unsubscribe'); expect(seen).toEqual([1, 1, 1])
})


it('has no collection notifications or status reads during ten virtual idle minutes', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  let off = () => {}
  try {
    const jobs = createWorkflowJobStore(), job = jobs.createJob('idle')
    jobs.kill(job.id)
    let changes = 0
    off = jobs.subscribeJobs!(() => { changes++ })
    const view = vi.spyOn(jobs, 'view'), list = vi.spyOn(jobs, 'list'), get = vi.spyOn(jobs, 'get')
    await vi.advanceTimersByTimeAsync(600_000)
    expect(vi.getTimerCount()).toBe(0); expect(changes).toBe(0); expect(view).not.toHaveBeenCalled(); expect(list).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled()
    off(); await vi.advanceTimersByTimeAsync(600_000)
    expect(vi.getTimerCount()).toBe(0); expect(changes).toBe(0); expect(view).not.toHaveBeenCalled(); expect(list).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled()
  } finally { off(); vi.useRealTimers() }
})
