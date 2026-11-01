import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'

it.skipIf(process.env.IH_ACL_INHERITED_QUALIFICATION !== '1')('qualifies inherited public child and runner', () => {
  const root = process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT
  if (!root) throw new Error('fresh evidence root required')
  const output = join(root, 'inherited-child-windows'), workspace = join(output, 'workspace'), temp = join(output, 'temp')
  mkdirSync(output); mkdirSync(workspace); mkdirSync(temp)
  const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href
  const env = { ...process.env, NODE_OPTIONS: '', NODE_DISABLE_COMPILE_CACHE: '1', TSX_DISABLE_CACHE: '1', TEMP: temp, TMP: temp, IH_ACL_INHERITED_CWD: output, IH_ACL_INHERITED_TRACE: join(output, 'inherited-trace.jsonl') }
  function run(phase: string, argv: string[]) {
    writeFileSync(join(output, `${phase}-command.json`), JSON.stringify({ executable: process.execPath, argv, cwd: output, timeoutMs: 20000, temp }, null, 2))
    const result = spawnSync(process.execPath, argv, { cwd: output, env, input: '', encoding: 'utf8', timeout: 20000, windowsHide: true })
    writeFileSync(join(output, `${phase}-stdout.txt`), result.stdout ?? '')
    writeFileSync(join(output, `${phase}-stderr.txt`), result.stderr ?? '')
    writeFileSync(join(output, `${phase}-result.json`), JSON.stringify({ status: result.status, pid: result.pid, signal: result.signal, error: result.error?.message }, null, 2))
    expect(result.error, result.stderr + result.stdout).toBeUndefined()
    return result
  }
  const fixture = fileURLToPath(new URL('./fixtures/inherited-child-windows.ts', import.meta.url))
  const inherited = run('inherited', ['--import', tsx, fixture])
  expect(inherited.status, inherited.stderr + inherited.stdout).toBe(0)
  expect(inherited.stdout).toBe('inherited-out-雪:1')
  expect(inherited.stderr).toBe('inherited-err-雪:EOF')
  const source = `const deadline=setTimeout(()=>process.exit(99),4000);process.stdin.on('end',()=>{clearTimeout(deadline);process.stdout.write('runner-out-雪');process.stderr.write('runner-err-雪');process.exitCode=23});process.stdin.resume()`
  const runner = fileURLToPath(new URL('../src/runner.ts', import.meta.url))
  const result = run('runner', ['--import', tsx, runner, '--workspace', workspace, '--temp', temp, '--mode', 'read-only', '--windows-hide', 'true', '--', process.execPath, '-e', source])
  expect(result.status, result.stderr + result.stdout).toBe(23)
  expect(result.stdout).toBe('runner-out-雪')
  expect(result.stderr).toBe('runner-err-雪')
  expect(result.stderr).not.toContain('windows-acl-run:')
}, 45000)
