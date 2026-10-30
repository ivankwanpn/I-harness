import { expect, it } from 'vitest'
import { createReadOwner, type ReadBoundary } from '../src/overlapped-read.ts'
import { Win32Error } from '../src/errors.ts'

it('joins pending readiness, copies data and observes EOF before release', async () => {
  let wake!: () => void
  let count = 0
  const trace: string[] = []
  const api: ReadBoundary = {
    submit: () => ++count === 1 ? { kind: 'pending' } : { kind: 'eof' },
    observe: () => ({ signalled: new Promise<void>(r => { wake = r }), close: async () => { trace.push('unregister') } }),
    result: () => ({ kind: 'data', bytes: Buffer.from('tail') }),
    cancel: () => { trace.push('cancel') },
    release: () => { trace.push('release') },
  }
  const owner = createReadOwner(api)
  const reading = owner.readAll()
  expect(trace).toEqual([])
  wake()
  expect((await reading).toString()).toBe('tail')
  expect(trace).toEqual(['unregister', 'release'])
})

it.each(['unregister', 'trampoline release'])('keeps terminal native error first when %s fails, without rereading on cleanup retry', async label => {
  const primary = new Win32Error('GetOverlappedResult', 5)
  const retirement = new Error(label)
  const laterFree = new Error('free failed')
  let results = 0, closes = 0, releases = 0
  const owner = createReadOwner({
    submit: () => ({ kind: 'pending' }),
    observe: () => ({ signalled: Promise.resolve(), close: async () => { if (++closes === 1) throw retirement } }),
    result: () => { results++; return { kind: 'error', error: primary } },
    cancel: () => {},
    release: () => { if (++releases === 1) throw laterFree },
  })
  const reading = owner.readAll()
  const failure = await reading.catch(error => error)
  expect(failure).toBeInstanceOf(AggregateError)
  expect(failure.errors).toEqual([primary, retirement])
  const cleanupFailure = await owner.cleanup().catch(error => error)
  expect(cleanupFailure.errors).toEqual([primary, laterFree])
  await owner.cleanup()
  expect(results).toBe(1)
  await expect(owner.readAll()).rejects.toBe(failure)
  expect(failure.errors[0]).toBe(primary)
})

it('does not release pending storage on cancellation until result and unregister are acknowledged', async () => {
  let wake!: () => void
  let releaseAck!: () => void
  const trace: string[] = []
  const api: ReadBoundary = {
    submit: () => ({ kind: 'pending' }),
    observe: () => ({ signalled: new Promise<void>(r => { wake = r }), close: () => new Promise<void>(r => { releaseAck = r }) }),
    result: () => ({ kind: 'aborted' }),
    cancel: () => { trace.push('cancel') },
    release: () => { trace.push('release') },
  }
  const owner = createReadOwner(api)
  const reading = owner.readAll().catch(() => undefined)
  const closing = owner.cancel()
  expect(trace).toEqual(['cancel'])
  wake()
  await Promise.resolve()
  expect(trace).toEqual(['cancel'])
  releaseAck()
  await Promise.all([reading, closing])
  expect(trace).toEqual(['cancel', 'release'])
})

it('retains submitted read when registration fails and retries observation during cleanup', async () => {
  const trace: string[] = []
  let observations = 0
  const api: ReadBoundary = {
    submit: () => ({ kind: 'pending' }),
    observe: () => {
      if (++observations === 1) throw new Error('registration failed')
      return { signalled: Promise.resolve(), close: async () => { trace.push('unregister') } }
    },
    result: () => ({ kind: 'aborted' }),
    cancel: () => { trace.push('cancel') },
    release: () => { trace.push('release') },
  }
  const owner = createReadOwner(api)
  await expect(owner.readAll()).rejects.toThrow('registration failed')
  expect(trace).toEqual(['cancel'])
  await owner.cleanup()
  expect(trace).toEqual(['cancel', 'unregister', 'release'])
})

it('acknowledges an unexpected completed read error before cleanup', async () => {
  const failure = new Error('read failure')
  const trace: string[] = []
  const owner = createReadOwner({
    submit: () => ({ kind: 'pending' }),
    observe: () => ({ signalled: Promise.resolve(), close: async () => { trace.push('unregister') } }),
    result: () => ({ kind: 'error', error: failure }),
    cancel: () => { trace.push('cancel') },
    release: () => { trace.push('release') },
  })
  await expect(owner.readAll()).rejects.toBe(failure)
  expect(trace).toEqual(['unregister'])
  await owner.cleanup()
  expect(trace).toEqual(['unregister', 'release'])
})
