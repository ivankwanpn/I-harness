import { expect, it } from 'vitest'
import { queueWaitDrain, validateBridgePath } from '../src/native-wait-bridge.ts'

it('rejects relative paths and unsupported architectures before loading a bridge', () => {
  expect(() => validateBridgePath('bridge.dll', 'win32', 'x64')).toThrow(/absolute/)
  expect(() => validateBridgePath('C:\\owned\\bridge.dll', 'win32', 'arm64')).toThrow(/x64/)
  expect(() => validateBridgePath('C:\\owned\\bridge.dll', 'linux', 'x64')).toThrow(/Windows/)
})

it('dispatches at most one unregister worker and yields before dispatch, including after failure', async () => {
  const trace: string[] = []
  let finish!: () => void
  const first = queueWaitDrain(() => { trace.push('first'); return new Promise<void>(resolve => { finish = resolve }) })
  const second = queueWaitDrain(async () => { trace.push('second'); throw new Error('FFI failure') })
  const caught = second.catch(error => error)
  const third = queueWaitDrain(async () => { trace.push('third'); return 0 })
  expect(trace).toEqual([])
  await new Promise<void>(resolve => setImmediate(resolve))
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(trace).toEqual(['first'])
  finish(); await first
  expect((await caught).message).toBe('FFI failure')
  expect(await third).toBe(0)
  expect(trace).toEqual(['first', 'second', 'third'])
})
