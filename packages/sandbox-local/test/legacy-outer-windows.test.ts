import { it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

it.skipIf(process.platform !== 'win32' || process.arch !== 'x64' || process.env.IH_LEGACY_OUTER_QUALIFICATION !== '1')('qualifies original legacy outer normal and READY cancellation', async () => {
  const root = process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT
  if (!root) throw new Error('fresh evidence root required')
  const cwd = join(root, 'legacy-outer-windows'); mkdirSync(cwd)
  const fixture = fileURLToPath(new URL('./fixtures/legacy-outer-windows.ts', import.meta.url))
  const args = ['--experimental-transform-types', fixture]
  const command = { executable: process.execPath, node: process.version, args, cwd, watchdogMs: 45000,
    env: { SystemRoot: process.env.SystemRoot, TEMP: cwd, TMP: cwd, NODE_OPTIONS: '' } }
  writeFileSync(join(cwd, 'command.json'), JSON.stringify(command, null, 2))
  const child = spawn(process.execPath, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...command.env, IH_LEGACY_OUTER_QUALIFICATION: '1', IH_LEGACY_OUTER_ROOT: cwd } })
  appendFileSync(join(cwd, 'wrapper.jsonl'), JSON.stringify({ event: 'host-started', pid: child.pid, parentPid: process.pid, command }) + '\n')
  let stdout = '', stderr = '', expired = false, spawnError: unknown
  child.stdout.on('data', b => { stdout += b; appendFileSync(join(cwd, 'stdout.txt'), b) })
  child.stderr.on('data', b => { stderr += b; appendFileSync(join(cwd, 'stderr.txt'), b) })
  child.on('error', e => { spawnError = e })
  const watchdog = setTimeout(() => {
    expired = true
    appendFileSync(join(cwd, 'wrapper.jsonl'), JSON.stringify({ event: 'watchdog-failure', pid: child.pid }) + '\n')
    // Ask the original host to cancel/release its retained original handle.
    // No PID lookup/kill or host teardown is a cleanup acknowledgment.
    if (child.connected) child.send({ event: 'abort-qualification' })
  }, 45000)
  const close = await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal }))) as { code: number | null; signal: string | null }
  clearTimeout(watchdog)
  writeFileSync(join(cwd, 'wrapper-result.json'), JSON.stringify({ ...close, pid: child.pid, expired, spawnError: String(spawnError), stdout, stderr }, null, 2))
  expect(expired).toBe(false); expect(spawnError).toBeUndefined(); expect(close.code, stderr + stdout).toBe(0)
  expect(stdout).toContain('"event":"qualification-complete"')
}, 55000)
