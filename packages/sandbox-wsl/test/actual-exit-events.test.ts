import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

const distribution = 'Ubuntu'
const wsl = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wsl.exe')
function evidence(label: string) {
  const root = process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT
  if (!root) throw new Error('fresh evidence root required')
  const path = join(root, label)
  mkdirSync(path)
  return path
}
function execute(path: string, label: string, args: string[], timeout: number) {
  writeFileSync(join(path, label + '-command.json'), JSON.stringify({ executable: wsl, args, cwd: process.cwd(), timeout, at: new Date().toISOString() }, null, 2))
  const result = spawnSync(wsl, args, { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 })
  writeFileSync(join(path, label + '-stdout.bin'), result.stdout ?? Buffer.alloc(0))
  writeFileSync(join(path, label + '-stderr.bin'), result.stderr ?? Buffer.alloc(0))
  writeFileSync(join(path, label + '-result.json'), JSON.stringify({ pid: result.pid, status: result.status, signal: result.signal, error: result.error?.message }, null, 2))
  expect(result.error, 'launcher timeout/error is failure, not guest cleanup').toBeUndefined()
  expect(result.status, result.stderr?.toString()).toBe(0)
  return result.stdout
}

it.skipIf(process.platform !== 'win32' || process.env.IH_WSL_EXIT_PREREQUISITES !== '1')('actual-worker prerequisites', () => {
  const path = evidence('wsl-prerequisites')
  execute(path, 'distributions', ['--list', '--verbose'], 15000)
  const code = "import sys,os,platform,shutil,json,ctypes,pathlib; names=['python3','bwrap','bash','cat','sleep','touch','setsid','wslpath','strace']; paths=['/proc/sys/user/max_user_namespaces','/proc/sys/kernel/unprivileged_userns_clone','/proc/sys/kernel/apparmor_restrict_unprivileged_userns']; print(json.dumps({'version':list(sys.version_info[:3]),'executable':sys.executable,'machine':platform.machine(),'release':platform.release(),'tools':{x:shutil.which(x) for x in names},'features':{x:hasattr(os,x) for x in ['O_PATH','O_CLOEXEC','memfd_create']},'statxSymbol':hasattr(ctypes.CDLL(None),'statx'),'sysctls':{p:pathlib.Path(p).read_text().strip() if pathlib.Path(p).exists() else None for p in paths}}))"
  const bytes = execute(path, 'inventory', ['--distribution', distribution, '--exec', '/usr/bin/python3', '-I', '-B', '-c', code], 15000)
  const inventory = JSON.parse(bytes.toString('utf8'))
  writeFileSync(join(path, 'inventory.json'), JSON.stringify(inventory, null, 2))
  expect(inventory.version[0] > 3 || (inventory.version[0] === 3 && inventory.version[1] >= 10)).toBe(true)
  expect(inventory.machine).toBe('x86_64')
  expect(inventory.release.toLowerCase()).toContain('microsoft')
  expect(inventory.release.toLowerCase()).toContain('wsl2')
  for (const name of ['python3', 'bwrap', 'bash', 'cat', 'sleep', 'touch', 'setsid', 'wslpath']) expect(inventory.tools[name], name).toBeTruthy()
  expect(Object.values(inventory.features).every(Boolean)).toBe(true)
  expect(inventory.statxSymbol).toBe(true)
  execute(path, 'bwrap-version', ['--distribution', distribution, '--exec', '/usr/bin/bwrap', '--version'], 15000)
  const help = execute(path, 'bwrap-help', ['--distribution', distribution, '--exec', '/usr/bin/bwrap', '--help'], 15000).toString('utf8')
  for (const flag of ['--bind-fd', '--ro-bind-fd', '--seccomp', '--unshare-all', '--new-session', '--die-with-parent']) expect(help).toContain(flag)
}, 70000)

const cases = [
  ['A0 startup', 'A0'],
  ['A1 stdin', 'A1'],
  ['A2 cancel-descendants', 'A2'],
  ['A3 control-eof', 'A3'],
  ['A4 root-exit-descendants', 'A4'],
] as const
it.skipIf(process.platform !== 'win32' || process.env.IH_WSL_ACTUAL_EXIT_EVENTS !== '1').each(cases)('actual-worker %s', (_name, selected) => {
  const path = evidence('actual-' + selected)
  const payload = resolve('test/actual_worker_cases.py')
  const guest = execute(path, 'wslpath', ['--distribution', distribution, '--exec', '/usr/bin/wslpath', '-u', payload], 15000).toString('utf8').trim()
  // Guest guard has its own bounded cleanup budget. Outer timeout is a final
  // failure guard, never a claim that killing wsl.exe acknowledged guest exit.
  const bytes = execute(path, selected, ['--distribution', distribution, '--exec', '/usr/bin/python3', '-I', '-B', guest, selected, '--allow-actual-current-worker'], 60000)
  const output = bytes.toString('utf8')
  writeFileSync(join(path, 'result-stdout.txt'), output)
  expect(output).toContain('ACTUAL_WORKER_CASE=' + selected)
  expect(output).toContain('ACTUAL_WORKER_CLEANUP=acknowledged')
  expect(output).toContain('ACTUAL_WORKER_PROTOCOL=acknowledged')
}, 65000)

it.skipIf(process.platform !== 'win32' || process.env.IH_WSL_ACTUAL_SOURCE_CHECK !== '1')('actual-worker harness source-check only', () => {
  const path = evidence('actual-harness-source-check')
  const guest = execute(path, 'wslpath', ['--distribution', distribution, '--exec', '/usr/bin/wslpath', '-u', resolve('test/actual_worker_cases.py')], 15000).toString('utf8').trim()
  const bytes = execute(path, 'source-check', ['--distribution', distribution, '--exec', '/usr/bin/python3', '-I', '-B', guest, '--source-check'], 15000)
  expect(bytes.toString('utf8')).toContain('ACTUAL_WORKER_SOURCE_CHECK=A0,A1,A2,A3,A4')
}, 35000)
