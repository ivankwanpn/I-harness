import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'

it.skipIf(process.env.IH_ACL_NATIVE_QUALIFICATION !== '1')('runs the assigned bounded Windows native wait/read fixture in an owned isolated process', () => {
  const root = process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT
  const assetRoot = process.env.IH_ACL_NATIVE_ASSET_ROOT
  if (!root || !assetRoot) throw new Error('assigned ROOT runner and asset candidate required')
  const output = join(root, 'native-read-windows')
  mkdirSync(output)
  const fixture = fileURLToPath(new URL('./fixtures/native-read-windows.ts', import.meta.url))
  const loader = createRequire(import.meta.url).resolve('tsx')
  const phase = process.env.IH_ACL_NATIVE_PHASE ?? 'all'
  const argv = ['--import', pathToFileURL(loader).href, fixture, phase]
  const env = { ...process.env, IH_ACL_NATIVE_TRACE: join(output, 'native-trace.jsonl'), TSX_DISABLE_CACHE: '1', TEMP: output, TMP: output }
  writeFileSync(join(output, 'command.json'), JSON.stringify({ executable: process.execPath, argv, cwd: process.cwd(), assetRoot, phase, childTemp: output, tsxDisableCache: true, timeoutMs: 15000, purpose: 'Failure bound; timeout is failure and never native ACK or qualification success' }, null, 2))
  const result = spawnSync(process.execPath, argv, { cwd: process.cwd(), env, encoding: 'utf8', timeout: 15000, windowsHide: true })
  writeFileSync(join(output, 'stdout.txt'), result.stdout ?? '')
  writeFileSync(join(output, 'stderr.txt'), result.stderr ?? '')
  writeFileSync(join(output, 'result.json'), JSON.stringify({ status: result.status, signal: result.signal, error: result.error?.message, pid: result.pid }, null, 2))
  expect(result.error, result.stderr).toBeUndefined()
  expect(result.status, result.stderr + result.stdout).toBe(0)
  expect(result.stdout).toContain('production-worker-exit-joined')
  expect(result.stdout).toContain('qualification-phase-complete')
  if (phase === 'all') for (const event of ['manual-event:signal-and-unregister-ack', 'immediate:ledger-empty', 'pending:ledger-empty', 'empty:ledger-empty', 'cancel:ledger-empty', 'error:ledger-empty']) expect(result.stdout).toContain(event)
}, 20000)
