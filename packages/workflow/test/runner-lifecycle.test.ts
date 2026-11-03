import { expect, it, vi } from 'vitest'
import type { ExecCommand, ExecResult, ExecService } from '@i-harness/exec'
import { createWorkflowExecutor, createWorkflowJobStore, reserveWorkflowIn, runWorkflowIn } from '../src/runner.ts'
import type { WorkflowDefinition } from '../src/definition.ts'

const ok: ExecResult = { stdout: '', stderr: '', exitCode: 0, timedOut: false }
const definition = (): WorkflowDefinition => ({ name: 'owned', description: 'owned', params: { value: {} }, steps: [{ name: 'one', command: 'echo ${value}', retry: { attempts: 2 } }] })
const service = (run: (command: ExecCommand) => Promise<ExecResult>) => ({ run }) as ExecService

it('reservation has no job, notifications or Exec effect and captures its original inputs', async () => {
  const jobs = createWorkflowJobStore(), changed = vi.fn(), calls: ExecCommand[] = []
  jobs.subscribeJobs!(changed)
  const def = definition(), params = { value: 'original' }
  const reservation = reserveWorkflowIn(def, params, service(async command => { calls.push(command); return ok }), jobs, 'session', 'original-cwd')
  let joined = false
  const join = reservation.join().then(value => { joined = true; return value })
  def.steps[0]!.command = 'changed'; params.value = 'changed'
  await Promise.resolve()
  expect(jobs.list()).toEqual([]); expect(changed).not.toHaveBeenCalled(); expect(calls).toEqual([]); expect(joined).toBe(false)
  const handle = reservation.start()
  expect(reservation.start()).toBe(handle)
  const completion = await join
  expect(calls.map(command => [command.argv, command.cwd])).toEqual([[['echo', 'original'], 'original-cwd']])
  expect(jobs.list()).toHaveLength(1); expect(handle.runId).toBe(handle.jobId)
  expect(completion.kind).toBe('loop-finished'); expect(completion.failures).toEqual([])
  expect(() => reservation.start.call({})).toThrow()
})

it('invalid reservation has zero effects and original identities differ across identical display ids', async () => {
  const run = vi.fn(async () => ok), exec = service(run), a = createWorkflowJobStore(), b = createWorkflowJobStore()
  const invalid = { ...definition(), params: { value: { required: true } } }
  expect(() => reserveWorkflowIn(invalid, {}, exec, a)).toThrow('missing required param')
  expect(a.list()).toEqual([]); expect(run).not.toHaveBeenCalled()
  const first = reserveWorkflowIn(definition(), {}, exec, a), second = reserveWorkflowIn(definition(), {}, exec, b)
  expect(first.invocationId).not.toBe(second.invocationId)
  expect(first.start().jobId).toBe(second.start().jobId)
  await Promise.all([first.join(), second.join()])
})

it('kill publishes its legacy status while the original loop join stays pending', async () => {
  const held = Promise.withResolvers<ExecResult>(), jobs = createWorkflowJobStore()
  const reservation = reserveWorkflowIn(definition(), {}, service(() => held.promise), jobs)
  const handle = reservation.start()
  let done = false
  const joined = reservation.join().then(value => { done = true; return value })
  expect(jobs.kill(handle.jobId)).toBe('cancellation-requested')
  expect(jobs.view(handle.jobId).status).toBe('killed')
  await Promise.resolve(); expect(done).toBe(false)
  held.resolve(ok)
  expect((await joined).status).toBe('killed')
})

it.each([undefined, null, false, 0, ''])('retains the exact original rejected attempt despite later successful retry (%j)', async cause => {
  let calls = 0
  const jobs = createWorkflowJobStore()
  const reservation = reserveWorkflowIn(definition(), {}, service(async () => { if (++calls === 1) throw cause; return ok }), jobs)
  const handle = reservation.start(), completion = await reservation.join()
  expect(calls).toBe(2); expect(jobs.view(handle.jobId).status).toBe('completed')
  expect(completion.failures).toHaveLength(1)
  expect(completion.failures[0]).toMatchObject({ step: 0, attempt: 1 })
  expect(completion.failures[0]!.cause).toBe(cause)
  expect(completion.cleanup).toBe('unqualified')
})

it('legacy entry and actual executor share the original reservation loop join', async () => {
  const jobs = createWorkflowJobStore(), exec = service(async () => ok)
  const direct = runWorkflowIn(definition(), {}, exec, jobs)
  expect(direct.invocationId).toBeTruthy(); expect((await direct.join()).kind).toBe('loop-finished')
  const executor = createWorkflowExecutor({ exec, jobs })
  const reserved = executor.reserveWorkflow(definition())
  const handle = reserved.start()
  expect(handle.invocationId).toBe(reserved.invocationId)
  expect(await handle.join()).toBe(await reserved.join())
  const legacy = executor.runWorkflow(definition())
  expect((await legacy.join()).kind).toBe('loop-finished')
})

it('original false rejection remains distinct from the legacy UI error and exit -1', async () => {
  const def = definition(); def.steps[0]!.retry = { attempts: 1 }
  const jobs = createWorkflowJobStore(), reservation = reserveWorkflowIn(def, {}, service(async () => { throw false }), jobs)
  const handle = reservation.start(), completion = await reservation.join()
  expect(jobs.view(handle.jobId)).toMatchObject({ status: 'error', exitCode: -1, stderr: 'false' })
  expect(completion.failures).toHaveLength(1); expect(completion.failures[0]!.cause).toBe(false)
  expect(completion.cleanup).toBe('unqualified')
})

it('a reentrant store observer cannot start the original reservation twice', async () => {
  const jobs = createWorkflowJobStore(), run = vi.fn(async () => ok)
  const reservation = reserveWorkflowIn(definition(), {}, service(run), jobs)
  let first = true, reentrant: unknown
  jobs.subscribeJobs!(() => {
    if (!first) return
    first = false
    try { reservation.start() } catch (cause) { reentrant = cause }
  })
  reservation.start(); await reservation.join()
  expect(reentrant).toBeInstanceOf(Error); expect(String(reentrant)).toContain('start in progress')
  expect(jobs.list()).toHaveLength(1); expect(run).toHaveBeenCalledTimes(1)
})

it('preserves source-limited native output in the original workflow completion',async()=>{
 const jobs=createWorkflowJobStore(),reservation=reserveWorkflowIn(definition(),{},service(async()=>({...ok,stdout:'partial',truncated:{stdout:true,stderr:false}})),jobs)
 const completion=await reservation.start().join();expect(completion.resultCompleteness).toBe('source-limited');expect(completion.result.steps[0]?.stdout).toBe('partial')
})
