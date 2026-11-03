import { expect, it } from 'vitest'
import { append, createSession, type ResultExecution } from '@i-harness/core-session'
import { createAgentRegistry } from '@i-harness/core-agent'
import { createResultCapture } from '../../output-retention/src/index.ts'
import { createAgentTable, type ChildAgentEntry } from '../src/agent-table.ts'
import { captureChildResult, publishChildResult } from '../src/child/result.ts'
import { driveFollowups } from '../src/followup/drive.ts'
import { createJobRegistry } from '../src/jobs.ts'
import type { TaskResultBody, TaskResultStore, TaskResultTarget } from '../src/task/result.ts'

// These controls qualify serialization around the original in-memory capture.
// Inline results deliberately confer no artifact storage or reader capability.
it.each(['held', 'rejected'] as const)('a %s original result settlement prevents new followup work and preserves its evidence', async mode => {
  const table = createAgentTable(), jobs = createJobRegistry(), agents = createAgentRegistry()
  const job = jobs.registerJob('root', 'subagent', 'child')
  const session = createSession()
  session.header = { parentSession: 'original-parent' }
  const entry: ChildAgentEntry = { path: 'root/child', session, status: 'waiting', controller: new AbortController(), mailbox: [], jobId: job.id, startedAt: 123 }
  table.add(entry.path, entry)
  const captures: { target: Readonly<TaskResultTarget>; body: TaskResultBody; revision: string; execution?: ResultExecution; current?: () => boolean }[] = []
  const results: TaskResultStore = {
    capture(target, body, revision, execution, current) {
      captures.push({ target, body, revision, execution, current })
      return createResultCapture(body, execution!, { openArtifact: async () => { throw new Error('Inline lifecycle fixture has no artifact owner') } })
    },
    read: async () => { throw new Error('Inline lifecycle fixture has no retained-body reader') },
  }
  const previousBody = { resultText: 'original 中文🙂 result', error: 'original diagnostic' }
  const previous = captureChildResult(results, entry, previousBody, 'completed')
  publishChildResult({ table, jobs }, entry, previous.projection(), 'completed')
  const originalProjection = previous.projection(), originalController = entry.controller
  const settlementEntered = Promise.withResolvers<void>(), settlementGate = Promise.withResolvers<void>()
  const guestEntered = Promise.withResolvers<void>(), guestGate = Promise.withResolvers<void>()
  const originalSettle = previous.settle.bind(previous)
  // Wrap the method on the original handle; entry.resultCapture identity and
  // its owner/current predicate stay intact throughout the held settlement.
  previous.settle = async () => { settlementEntered.resolve(); await settlementGate.promise; return originalSettle() }
  let followups = 0
  agents.register('original-child', {
    run: async () => { throw new Error('Followup must use the existing child') },
    followup: async message => {
      expect(message).toBe('next original child turn')
      followups++
      guestEntered.resolve()
      await guestGate.promise
      return { finalText: 'new 中文🙂 result', turns: 1, reasoning: [] }
    },
  })
  append(session, { type: 'subagent/inbox', message: 'next original child turn', messageId: 'original-inbox' })
  const resident: string[] = [], jobPatches: string[] = []
  const unsubscribeTable = table.subscribe(change => { resident.push(change.entry.status) })
  const unsubscribeJob = jobs.subscribe(job.id, view => { jobPatches.push(view.status) })
  const driving = driveFollowups({ table, jobs, agents, results }, entry, 'original-child')
  const failure = new Error('original settlement rejected')
  const rejected = mode === 'rejected' ? expect(driving).rejects.toBe(failure) : undefined
  try {
    await settlementEntered.promise
    expect(entry.resultCapture).toBe(previous)
    expect(previous.projection()).toEqual(originalProjection)
    expect(entry).toMatchObject({ status: 'waiting', finalText: previousBody.resultText, error: previousBody.error, startedAt: 123, result: originalProjection.result })
    expect(entry.controller).toBe(originalController)
    expect(jobs.read(job.id)).toMatchObject({ status: 'completed', output: previousBody.resultText, result: originalProjection.result })
    expect(resident).toEqual([])
    expect(jobPatches).toEqual([])
    expect(followups).toBe(0)
    expect(captures).toHaveLength(1)
    expect(captures[0]!.target).toMatchObject({ id: job.id, parentSessionId: 'original-parent', outcome: 'completed' })
    expect(captures[0]!.body).toBe(previousBody)
    expect(captures[0]!.execution).toEqual({ outcome: 'succeeded', dispatch: 'dispatched' })
    expect(captures[0]!.current!()).toBe(true)
    expect(entry.lastInboxSeq).toBeUndefined()
    if (mode === 'rejected') {
      settlementGate.reject(failure)
      await rejected
      expect(entry.resultCapture).toBe(previous)
      expect(previous.projection()).toEqual(originalProjection)
      expect(entry).toMatchObject({ status: 'waiting', finalText: previousBody.resultText, error: previousBody.error, startedAt: 123, result: originalProjection.result })
      expect(entry.controller).toBe(originalController)
      expect(jobs.read(job.id)).toMatchObject({ status: 'completed', output: previousBody.resultText, result: originalProjection.result })
      expect(entry.lastInboxSeq).toBeUndefined()
      expect(captures[0]!.current!()).toBe(true)
      expect(captures).toHaveLength(1)
      expect(followups).toBe(0)
      expect(resident).toEqual([])
      expect(jobPatches).toEqual([])
    } else {
      settlementGate.resolve()
      await guestEntered.promise
      expect(previous.projection().result).toMatchObject({ kind: 'retained', revision: captures[0]!.revision, envelope: { retention: { kind: 'inline', value: previousBody } } })
      expect(entry.controller).not.toBe(originalController)
      expect(entry.startedAt).toEqual(expect.any(Number))
      expect(entry).toMatchObject({ status: 'running', finalText: undefined, error: undefined, result: undefined })
      expect(jobs.read(job.id)).toMatchObject({ status: 'running', output: '' })
      expect(captures).toHaveLength(1)
      expect(followups).toBe(1)
      expect(resident).toEqual(['running'])
      expect(jobPatches).toEqual(['running'])
      guestGate.resolve()
      await driving
      expect(followups).toBe(1)
      expect(captures).toHaveLength(2)
      expect(captures[1]!.target.id).toBe(job.id)
      expect(captures[1]!.body).toEqual({ resultText: 'new 中文🙂 result' })
      expect(captures[1]!.revision).not.toBe(captures[0]!.revision)
      expect(captures[0]!.current!()).toBe(false)
      expect(captures[1]!.current!()).toBe(true)
      expect(entry.resultCapture).not.toBe(previous)
      expect(entry).toMatchObject({ status: 'waiting', finalText: 'new 中文🙂 result', error: undefined, result: { kind: 'retained', revision: captures[1]!.revision } })
      expect(jobs.read(job.id)).toMatchObject({ status: 'completed', output: 'new 中文🙂 result', result: { kind: 'retained', revision: captures[1]!.revision } })
      expect(resident).toEqual(['running', 'waiting', 'waiting'])
      expect(jobPatches).toEqual(['running', 'completed', 'completed'])
    }
  } finally {
    if (mode === 'rejected') settlementGate.reject(failure)
    else settlementGate.resolve()
    guestGate.resolve()
    try { if (rejected) await rejected; else await driving }
    finally { unsubscribeTable(); unsubscribeJob() }
  }
})
