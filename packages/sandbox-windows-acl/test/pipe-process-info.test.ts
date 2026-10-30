import { expect, it } from 'vitest'
import { createProcessInfoState } from '../src/pipe-process-info.ts'

it('records creation before independent decode and never reissues', () => {
  let calls = 0, fail = true
  const owner = createProcessInfoState({ issue() { calls++; return 1 }, lastError() { return 5 }, readProcess() { if (fail) throw Error('decode'); return 10n }, readThread() { return 20n }, readPid() { return 42 } })
  owner.issue(); expect(owner.phase()).toBe('created')
  expect(() => owner.process()).toThrow('decode')
  expect(owner.thread()).toBe(20n); expect(owner.pid()).toBe(42)
  fail = false; expect(owner.process()).toBe(10n)
  expect(() => owner.issue()).toThrow(); expect(calls).toBe(1)
})
it('pins unknown issue and distinguishes a known failure', () => {
  const make = (issue: () => number) => createProcessInfoState({ issue, lastError: () => 7, readProcess: () => 1n, readThread: () => 2n, readPid: () => 3 })
  const unknown = make(() => { throw undefined }); expect(() => unknown.issue()).toThrow(); expect(unknown.phase()).toBe('unknown')
  const failed = make(() => 0); expect(() => failed.issue()).toThrow(); expect(failed.phase()).toBe('failed')
})
