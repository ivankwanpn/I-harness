import { expect, it } from 'vitest'
import { killWindowsProcessTree } from '../src/process-tree.ts'

it('waits for taskkill to finish and resolves on spawn errors (A-11)', async () => {
  const calls: unknown[] = []
  const fake = ((command: string, args: string[], options: unknown) => {
    calls.push([command, args, options])
    const listeners = new Map<string, () => void>()
    return { once(event: string, listener: () => void) { listeners.set(event, listener); if (event === 'exit') queueMicrotask(listener); return this } }
  }) as never
  await killWindowsProcessTree(4242, fake)
  expect(calls).toEqual([['taskkill', ['/PID', '4242', '/T', '/F'], { windowsHide: true, stdio: 'ignore' }]])
})

it('never rejects when taskkill cannot be spawned', async () => {
  const fake = (() => { throw new Error('spawn failed') }) as never
  await expect(killWindowsProcessTree(7, fake)).resolves.toBeUndefined()
})
