import { expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { acquireSessionLock, SessionLockConflictError } from '../src/index.ts'

const supported = it.skipIf(!['win32', 'linux'].includes(process.platform))
supported.each([
  { mode: 'shared' as const, end: 'close' }, { mode: 'exclusive' as const, end: 'close' },
  { mode: 'shared' as const, end: 'crash' }, { mode: 'exclusive' as const, end: 'crash' },
])('releases actual cross-process $mode ownership on $end', async ({ mode, end }) => {
  const root = await mkdtemp(join(tmpdir(), 'ih-native-release-')), path = join(root, 'owned.lock')
  let child: ChildProcess | undefined, stderr = ''
  try {
    child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/lease-holder.mjs', import.meta.url)), path, mode], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true })
    child.stdout?.resume(); child.stderr?.on('data', bytes => { stderr = (stderr + bytes).slice(-8192) })
    const earlyExit = once(child, 'exit').then(([code]) => ({ kind: 'early-exit', code, stderr }))
    expect(await Promise.race([once(child, 'message').then(([message]) => message), earlyExit])).toEqual({ kind: 'ready' })
    await expect(acquireSessionLock({ lockPath: path, deadlineMs: 20, retryMs: 5 })).rejects.toBeInstanceOf(SessionLockConflictError)
    const exit = once(child, 'exit')
    if (end === 'crash') child.kill('SIGKILL')
    else {
      const released = once(child, 'message')
      child.send!('close')
      expect((await released)[0]).toEqual({ kind: 'released' })
    }
    await exit; child = undefined
    const successor = await acquireSessionLock({ lockPath: path, deadlineMs: 1000, retryMs: 5 })
    try { expect(successor.held).toBe(true) } finally { await successor.release() }
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited }
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('ih-native-release-')) throw Error('Unsafe fixture cleanup')
    await rm(root, { recursive: true, force: true })
  }
}, 20000)
