import { expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

it('checks the independent Job fixture imports before any native or sandbox operation', () => {
  const root = process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT
  if (!root) throw new Error('fresh evidence root required')
  const cwd = join(root, 'independent-job-source-check'); mkdirSync(cwd)
  const fixture = fileURLToPath(new URL('./fixtures/independent-inherited-job.ts', import.meta.url))
  const args = ['--experimental-transform-types', fixture, '--source-check']
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: '', NODE_DISABLE_COMPILE_CACHE: '1' }
  for (const key of ['IH_ACL_INDEPENDENT_JOB', 'IH_ACL_JOB_NONCE', 'IH_ACL_JOB_CWD', 'IH_ACL_JOB_TRACE']) delete env[key]
  writeFileSync(join(cwd, 'command.json'), JSON.stringify({ executable: process.execPath, args, cwd, scope: 'unrestricted-source-import-only', nativeGateAbsent: true }, null, 2))
  const result = spawnSync(process.execPath, args, { cwd, env, timeout: 5000, windowsHide: true, encoding: 'utf8' })
  writeFileSync(join(cwd, 'stdout.txt'), result.stdout ?? ''); writeFileSync(join(cwd, 'stderr.txt'), result.stderr ?? '')
  writeFileSync(join(cwd, 'result.json'), JSON.stringify({ status: result.status, pid: result.pid, signal: result.signal, error: result.error?.message }, null, 2))
  expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({ event: 'source-check-ok', fixture, loader: 'node-experimental-transform-types' })
})
