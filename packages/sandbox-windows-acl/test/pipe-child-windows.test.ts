import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'

it.skipIf(process.env.IH_ACL_PIPE_QUALIFICATION !== '1')('qualifies one public default pipe child', () => {
  const root = process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT
  if (!root) throw new Error('fresh evidence root required')
  const output = join(root, 'pipe-child-windows')
  mkdirSync(output)
  const argv = ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href, fileURLToPath(new URL('./fixtures/pipe-child-windows.ts', import.meta.url))]
  const env = { ...process.env, NODE_OPTIONS: '', NODE_DISABLE_COMPILE_CACHE: '1', TSX_DISABLE_CACHE: '1', TEMP: output, TMP: output, IH_ACL_PIPE_TRACE: join(output, 'trace.jsonl'), IH_ACL_PIPE_CWD: output }
  writeFileSync(join(output, 'command.json'), JSON.stringify({ executable: process.execPath, argv, cwd: output, timeoutMs: 20000 }, null, 2))
  const result = spawnSync(process.execPath, argv, { cwd: output, env, encoding: 'utf8', timeout: 20000, windowsHide: true })
  writeFileSync(join(output, 'stdout.txt'), result.stdout ?? '')
  writeFileSync(join(output, 'stderr.txt'), result.stderr ?? '')
  writeFileSync(join(output, 'result.json'), JSON.stringify({ status: result.status, pid: result.pid, signal: result.signal, error: result.error?.message }, null, 2))
  expect(result.error, result.stderr + result.stdout).toBeUndefined()
  expect(result.status, result.stderr + result.stdout).toBe(0)
  expect(result.stdout).toContain('public-pipe-complete')
}, 25000)
